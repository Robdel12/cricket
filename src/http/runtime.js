import http from 'node:http';
import {
  setImmediate as nextTick
} from 'node:timers/promises';

import { supportedEndpointMethods } from '../endpoint.js';
import {
  isMainModule,
  resolveCricketApp
} from '../app.js';
import { createServices } from '../domain.js';
import {
  expectationFailed,
  toHttpError
} from '../errors.js';
import { normalizeLogger } from '../logger.js';
import {
  assertAllowedHost,
  completeRequestBody,
  createBaseRequest
} from './request.js';
import {
  allowedMethodsForPath,
  endpointWithPrefix,
  joinPaths,
  matchRoute,
  prepareRoutes
} from './router.js';
import { writeHttpResponse } from './response.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function normalizeSetupResult(result) {
  if (!result)
    return {
      dependencies: {},
      services: {},
      cleanup: undefined
    };

  if (result.dependencies || result.services || result.cleanup)
    return {
      dependencies: result.dependencies ?? {},
      services: result.services ?? {},
      cleanup: result.cleanup
    };

  return {
    dependencies: result,
    services: {},
    cleanup: undefined
  };
}

async function resolveMiddleware(middleware, runtime) {
  let value = typeof middleware === 'function'
    ? await middleware(runtime)
    : middleware;

  return toArray(value);
}

function defaultNotFound(request) {
  return {
    status: 404,
    body: {
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.path}`
      }
    }
  };
}

function methodNotAllowed(request, allowedMethods) {
  return {
    status: 405,
    headers: {
      Allow: allowedMethods.join(', ')
    },
    body: {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${request.method} is not allowed for ${request.path}`
      }
    }
  };
}

function optionsResponse(allowedMethods) {
  return {
    status: 204,
    headers: {
      Allow: allowedMethods.join(', ')
    }
  };
}

function composeMiddleware(middleware, finalHandler) {
  return middleware.reduceRight(
    (next, use) => requestContext => use(requestContext, next),
    finalHandler
  );
}

function closeClientErrorSocket(error, socket, logger) {
  try {
    logger.error('server.client_error', {
      code: error?.code,
      bytesParsed: error?.bytesParsed
    });
  } catch {
    // Parser-level errors should never create a logging failure path.
  }

  if (!socket.writable) {
    socket.destroy();
    return;
  }

  let status = error?.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  let reason = status === 431
    ? 'Request Header Fields Too Large'
    : 'Bad Request';

  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n'));
}

function closeUnsupportedProtocolSocket(req, socket, logger, event) {
  try {
    logger.warn('server.unsupported_protocol', {
      event,
      method: req?.method,
      url: req?.url
    });
  } catch {
    // Unsupported protocol paths should never create a logging failure path.
  }

  if (!socket.writable) {
    socket.destroy();
    return;
  }

  socket.end([
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n'));
}

function createNodeServer(handle, logger) {
  let server = http.createServer(handle);

  server.on('checkContinue', (req, res) => {
    void handle(req, res, {
      expectContinue: true
    });
  });
  server.on('checkExpectation', (req, res) => {
    writeHttpResponse(req, res, toHttpError(expectationFailed()));
  });
  server.on('clientError', (error, socket) => {
    closeClientErrorSocket(error, socket, logger);
  });
  server.on('connect', (req, socket) => {
    closeUnsupportedProtocolSocket(req, socket, logger, 'connect');
  });
  server.on('upgrade', (req, socket) => {
    closeUnsupportedProtocolSocket(req, socket, logger, 'upgrade');
  });

  return server;
}

function baseContextFor({
  logger,
  services,
  setup
}) {
  return {
    ...setup.dependencies,
    logger,
    services
  };
}

async function resolveContext(appContract, {
  baseContext,
  request,
  setup
}) {
  if (!appContract.context)
    return baseContext;

  let appContext = await appContract.context({
    app: appContract,
    request,
    dependencies: setup.dependencies,
    logger: baseContext.logger,
    services: baseContext.services
  }) ?? {};

  return {
    ...appContext,
    ...baseContext
  };
}

async function resolveRequestContext(appContract, requestContext, {
  request = requestContext.request,
  setup
}) {
  let context = await resolveContext(appContract, {
    baseContext: requestContext.context,
    request,
    setup
  });

  return {
    ...requestContext,
    context,
    request
  };
}

function withMatchedParams(request, match) {
  return {
    ...request,
    params: match?.params ?? {}
  };
}

async function runEndpoint(requestContext, endpoint) {
  return await endpoint.handle(requestContext.request, requestContext.context);
}

async function reportRequestError(appContract, {
  baseRequest,
  error,
  logger,
  response
}) {
  try {
    logger.error('request.failed', {
      error,
      method: baseRequest?.method,
      path: baseRequest?.path
    });
  } catch {
    // Error reporting must never prevent Cricket from sending the response.
  }

  if (!appContract.onError)
    return;

  try {
    await appContract.onError(error, {
      request: baseRequest,
      response
    });
  } catch (onErrorFailure) {
    try {
      logger.error('request.error_handler_failed', {
        error: onErrorFailure,
        originalError: error,
        method: baseRequest?.method,
        path: baseRequest?.path
      });
    } catch {
      // Keep the original response path intact.
    }
  }
}

function createRuntimeHandler({
  appContract,
  logger,
  routes,
  setup,
  services,
  use
}) {
  return async function handle(req, res, {
    expectContinue = false
  } = {}) {
    let baseRequest;
    let continued = false;

    function writeContinue() {
      if (!expectContinue || continued || res.headersSent)
        return;

      continued = true;
      res.writeContinue();
    }

    try {
      baseRequest = createBaseRequest(req, {
        trustProxy: appContract.trustProxy
      });
      assertAllowedHost(baseRequest, appContract.allowedHosts);

      if (!supportedEndpointMethods.includes(baseRequest.method.toUpperCase())) {
        writeHttpResponse(
          req,
          res,
          methodNotAllowed(baseRequest, supportedEndpointMethods)
        );
        return;
      }

      if (baseRequest.method.toUpperCase() === 'OPTIONS' && baseRequest.path === '*') {
        writeHttpResponse(req, res, optionsResponse(supportedEndpointMethods));
        return;
      }

      let context = baseContextFor({
        logger,
        services,
        setup
      });
      let requestContext = {
        app: appContract,
        context,
        logger,
        request: baseRequest,
        services
      };
      let finalHandler = async nextRequestContext => {
        let match = matchRoute(routes, nextRequestContext.request);

        if (match) {
          let matchedRequest = withMatchedParams(nextRequestContext.request, match);
          let requestContextForMatchedRequest = await resolveRequestContext(appContract, nextRequestContext, {
            request: matchedRequest,
            setup
          });

          writeContinue();

          let parsedRequest = await completeRequestBody(
            req,
            requestContextForMatchedRequest.request,
            match.endpoint
          );

          return await runEndpoint({
            ...requestContextForMatchedRequest,
            request: parsedRequest
          }, match.endpoint);
        }

        let allowedMethods = allowedMethodsForPath(routes, nextRequestContext.request);

        if (allowedMethods.length && nextRequestContext.request.method.toUpperCase() === 'OPTIONS')
          return optionsResponse(allowedMethods);

        if (allowedMethods.length)
          return methodNotAllowed(nextRequestContext.request, allowedMethods);

        let requestContextForRequest = await resolveRequestContext(appContract, nextRequestContext, {
          setup
        });

        if (appContract.fallback)
          return await appContract.fallback(requestContextForRequest);

        return defaultNotFound(requestContextForRequest.request);
      };
      let response = await composeMiddleware(use, finalHandler)(requestContext);

      writeHttpResponse(req, res, response);
    } catch (error) {
      let response = toHttpError(error);

      await reportRequestError(appContract, {
        baseRequest,
        error,
        logger,
        response
      });

      writeHttpResponse(req, res, response);
    }
  };
}

function closeServer(server, {
  closeConnections = 'idle'
} = {}) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error)
        reject(error);
      else
        nextTick().then(resolve, reject);
    });

    if (closeConnections === 'all')
      server.closeAllConnections?.();
    else if (closeConnections === 'idle')
      server.closeIdleConnections?.();
  });
}

/**
 * Create a Cricket runtime from an app contract.
 *
 * Resolves domains, sets up services, compiles middleware and routes, and returns
 * a ready-to-use HTTP handler. This is where all app config becomes concrete.
 *
 * @param {object} cricketApp - App contract from defineCricketApp().
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - Module URL for resolving relative domain paths.
 * @param {object} [options.logger] - App logger for the runtime.
 * @returns {Promise<{
 *   app: Function,
 *   contract: object,
 *   dependencies: object,
 *   handle: Function,
 *   logger: object,
 *   services: object,
 *   cleanup: Function|undefined
 * }>} Runtime object with handler and context.
 */
export async function createCricketRuntime(cricketApp, {
  baseUrl,
  logger: runtimeLogger
} = {}) {
  let appContract = await resolveCricketApp(cricketApp, {
    baseUrl
  });
  let logger = normalizeLogger(runtimeLogger ?? appContract.logger ?? console);
  let setup = normalizeSetupResult(
    appContract.setup ? await appContract.setup({
      app: appContract,
      logger
    }) : undefined
  );
  let domainServices = createServices(appContract.domains, {
    ...setup.dependencies,
    logger
  });
  let defaultServices = {
    ...domainServices,
    ...setup.services
  };
  let services = defaultServices;

  if (typeof appContract.services === 'function') {
    services = await appContract.services({
      app: appContract,
      dependencies: setup.dependencies,
      domainServices,
      logger,
      services: defaultServices
    });
  } else if (appContract.services) {
    services = appContract.services;
  }

  let runtimeBag = {
    app: appContract,
    dependencies: setup.dependencies,
    domainServices,
    logger,
    services
  };
  let use = await resolveMiddleware(appContract.use, runtimeBag);
  let prefixedEndpoints = appContract.endpoints.map(endpoint =>
    endpointWithPrefix(endpoint, appContract.prefix)
  );
  let routes = prepareRoutes(prefixedEndpoints);
  let handle = createRuntimeHandler({
    appContract,
    logger,
    routes,
    setup,
    services,
    use
  });
  let app = Object.assign(handle, {
    handle,
    listen(...args) {
      let server = createNodeServer(handle, logger);
      return server.listen(...args);
    }
  });

  return {
    app,
    contract: appContract,
    dependencies: setup.dependencies,
    handle,
    logger,
    services,
    cleanup: setup.cleanup
  };
}

/**
 * Start a Cricket app as a standalone HTTP server.
 *
 * Creates the runtime and starts listening on the specified port. Only runs when
 * the module is the main entrypoint (checked via `main` parameter).
 *
 * @param {object} cricketApp - App contract from defineCricketApp().
 * @param {object} [options]
 * @param {number} [options.port=3000] - Port to listen on.
 * @param {string} [options.host] - Host to bind to (defaults to all interfaces).
 * @param {string|URL} [options.main] - Module URL to check if this is the main module.
 * @param {object} [options.logger] - App logger for the runtime.
 * @returns {Promise<{
 *   app: Function,
 *   contract: object,
 *   dependencies: object,
 *   handle: Function,
 *   logger: object,
 *   server: object,
 *   services: object,
 *   cleanup: Function|undefined,
 *   stop: Function
 * }|undefined>} Running app or undefined if not main module.
 */
export async function startCricketApp(cricketApp, {
  port = 3000,
  host,
  main,
  logger
} = {}) {
  if (main && !isMainModule(main))
    return undefined;

  let runtime = await createCricketRuntime(cricketApp, {
    baseUrl: main,
    logger
  });
  let server = runtime.app.listen(port, host, () => {
    runtime.logger.info('server.started', {
      app: runtime.contract.name ?? 'Cricket app',
      port,
      url: `http://localhost:${port}`
    });
  });

  async function stop(signal, {
    closeConnections = 'idle'
  } = {}) {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);

    let shutdownError;

    try {
      if (signal && runtime.contract.onShutdown)
        await runtime.contract.onShutdown({
          signal,
          ...runtime
        });
    } catch (error) {
      shutdownError = error;
    } finally {
      try {
        await closeServer(server, {
          closeConnections
        });
      } finally {
        if (runtime.cleanup)
          await runtime.cleanup();
      }
    }

    if (shutdownError)
      throw shutdownError;
  }

  let shutdown = async signal => {
    await stop(signal);
    process.exit(0);
  };
  let onSigint = () => {
    void shutdown('SIGINT');
  };
  let onSigterm = () => {
    void shutdown('SIGTERM');
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return {
    ...runtime,
    server,
    stop
  };
}
