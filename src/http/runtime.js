import http from 'node:http';
import {
  setImmediate as nextTick
} from 'node:timers/promises';

import {
  assertEndpointAuth,
  supportedEndpointMethods
} from '../endpoint.js';
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
import { generateOpenApi } from '../openapi.js';
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

let defaultServerOptions = {
  headersTimeout: 60_000,
  keepAliveTimeout: 5_000,
  keepAliveTimeoutBuffer: 1_000,
  maxHeaderSize: 16 * 1024,
  maxHeadersCount: 100,
  maxRequestsPerSocket: 1_000,
  requestTimeout: 120_000,
  timeout: 0,
  insecureHTTPParser: false,
  requireHostHeader: true
};

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

async function resolveRuntimeHooks(hooks, runtime) {
  let value = typeof hooks === 'function'
    ? await hooks(runtime)
    : hooks;

  return toArray(value);
}

function openApiOptionsFor(cricketApp) {
  if (cricketApp.openApi === false)
    return false;

  let options = {
    title: cricketApp.name,
    version: cricketApp.version,
    description: cricketApp.description,
    models: cricketApp.models,
    path: '/openapi.json'
  };

  if (cricketApp.openApi === true)
    return options;

  return {
    ...options,
    ...cricketApp.openApi
  };
}

function responseFromOpenApi(openApi, {
  endpoints,
  prefix
}) {
  if (!openApi)
    return undefined;

  let {
    path = '/openapi.json',
    document,
    ...options
  } = openApi;

  return {
    path,
    response: {
      status: 200,
      body: document ?? generateOpenApi({
        ...options,
        pathPrefix: prefix,
        endpoints
      })
    }
  };
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

function composeHooks(hooks, finalHandler) {
  return hooks.reduceRight(
    (next, hook) => exchange => hook(exchange, next),
    finalHandler
  );
}

function omitUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function serverOptionsFor(...configs) {
  let merged = Object.assign({}, defaultServerOptions, ...configs.filter(Boolean));
  let {
    maxHeadersCount,
    maxRequestsPerSocket,
    timeout,
    ...createServerOptions
  } = merged;

  return {
    createServerOptions: omitUndefined(createServerOptions),
    maxHeadersCount,
    maxRequestsPerSocket,
    timeout
  };
}

function applyServerRuntimeOptions(server, options) {
  if (options.maxHeadersCount !== undefined)
    server.maxHeadersCount = options.maxHeadersCount;

  if (options.maxRequestsPerSocket !== undefined)
    server.maxRequestsPerSocket = options.maxRequestsPerSocket;

  if (options.timeout !== undefined)
    server.timeout = options.timeout;
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

function createNodeServer(handle, options, logger) {
  let normalized = serverOptionsFor(options);
  let server = http.createServer(normalized.createServerOptions, handle);

  applyServerRuntimeOptions(server, normalized);
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
    services,
    state: {}
  };
}

async function resolveContext(appContract, {
  baseContext,
  request,
  state,
  setup
}) {
  let currentState = state ?? baseContext.state ?? {};

  if (!appContract.context)
    return {
      ...baseContext,
      state: currentState
    };

  let appContext = await appContract.context({
    app: appContract,
    request,
    dependencies: setup.dependencies,
    logger: baseContext.logger,
    services: baseContext.services
  }) ?? {};

  return {
    ...appContext,
    ...baseContext,
    state: {
      ...(appContext.state ?? {}),
      ...currentState
    }
  };
}

async function resolveExchangeContext(appContract, exchange, {
  request = exchange.request,
  setup
}) {
  let context = await resolveContext(appContract, {
    baseContext: exchange.context,
    request,
    state: exchange.state,
    setup
  });

  return {
    ...exchange,
    context,
    request,
    state: context.state
  };
}

function withMatchedParams(request, match) {
  return {
    ...request,
    params: match?.params ?? {}
  };
}

async function runEndpoint(exchange, endpoint) {
  return await endpoint.handle(exchange.request, exchange.context);
}

async function runEndpointBefore(exchange, endpoint) {
  let before = toArray(endpoint.before);
  let finalHandler = async nextExchange => nextExchange;

  return await composeHooks(before, finalHandler)(exchange);
}

function isExchange(value) {
  return value &&
    typeof value === 'object' &&
    value.request &&
    value.context;
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
  openApi,
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
      let exchange = {
        app: appContract,
        context,
        logger,
        request: baseRequest,
        services,
        state: context.state ?? {}
      };
      let finalHandler = async nextExchange => {
        if (
          openApi &&
          nextExchange.request.method.toUpperCase() === 'GET' &&
          nextExchange.request.path === openApi.path
        )
          return openApi.response;

        let match = matchRoute(routes, nextExchange.request);

        if (match) {
          let matchedRequest = withMatchedParams(nextExchange.request, match);
          let exchangeForMatchedRequest = await resolveExchangeContext(appContract, nextExchange, {
            request: matchedRequest,
            setup
          });

          assertEndpointAuth(match.endpoint, exchangeForMatchedRequest.context);

          let preparedExchange = await runEndpointBefore({
            ...exchangeForMatchedRequest
          }, match.endpoint);

          if (!isExchange(preparedExchange))
            return preparedExchange;

          writeContinue();

          let parsedRequest = await completeRequestBody(
            req,
            preparedExchange.request,
            match.endpoint
          );

          return await runEndpoint({
            ...preparedExchange,
            request: parsedRequest,
          }, match.endpoint);
        }

        let allowedMethods = allowedMethodsForPath(routes, nextExchange.request);

        if (allowedMethods.length && nextExchange.request.method.toUpperCase() === 'OPTIONS')
          return optionsResponse(allowedMethods);

        if (allowedMethods.length)
          return methodNotAllowed(nextExchange.request, allowedMethods);

        let exchangeForRequest = await resolveExchangeContext(appContract, nextExchange, {
          setup
        });

        if (appContract.fallback)
          return await appContract.fallback(exchangeForRequest);

        return defaultNotFound(exchangeForRequest.request);
      };
      let response = await composeHooks(use, finalHandler)(exchange);

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

export async function createCricketRuntime(cricketApp, {
  baseUrl,
  logger: runtimeLogger,
  server: runtimeServer
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
  let use = await resolveRuntimeHooks(appContract.use, runtimeBag);
  let prefixedEndpoints = appContract.endpoints.map(endpoint =>
    endpointWithPrefix(endpoint, appContract.prefix)
  );
  let routes = prepareRoutes(prefixedEndpoints);
  let openApi = responseFromOpenApi(openApiOptionsFor(appContract), {
    endpoints: appContract.endpoints,
    prefix: appContract.prefix
  });
  let handle = createRuntimeHandler({
    appContract,
    logger,
    openApi,
    routes,
    setup,
    services,
    use
  });
  let app = Object.assign(handle, {
    handle,
    listen(...args) {
      let server = createNodeServer(handle, {
        ...appContract.server,
        ...runtimeServer
      }, logger);
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

export async function startCricketApp(cricketApp, {
  port = 3000,
  host,
  main,
  logger,
  server: serverOptions
} = {}) {
  if (main && !isMainModule(main))
    return undefined;

  let runtime = await createCricketRuntime(cricketApp, {
    baseUrl: main,
    logger,
    server: serverOptions
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
