import http from 'node:http';
import { performance } from 'node:perf_hooks';
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
import { resolveLogger } from '../logger.js';
import { normalizeObservability } from '../observability.js';
import {
  createNoopTrace,
  createTrace
} from '../trace.js';
import {
  assertAllowedHost,
  completeRequestBody,
  createBaseRequest,
  safeRequestSnapshot
} from './request.js';
import {
  allowedMethodsForPath,
  endpointWithPrefix,
  joinPaths,
  matchRoute,
  prepareRoutes,
  routeIdentityFor
} from './router.js';
import {
  safeResponseSnapshot,
  writeHttpResponse
} from './response.js';

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

/**
 * Check for a response header without caring how the app cased the name.
 *
 * @param {Record<string, any>} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers = {}, name) {
  let normalized = name.toLowerCase();

  return Object.keys(headers).some(header => header.toLowerCase() === normalized);
}

/**
 * Add a framework-owned response header unless the handler already set it.
 *
 * @param {Record<string, any>} headers
 * @param {string} name
 * @param {string|undefined} value
 * @returns {Record<string, any>}
 */
function withDefaultHeader(headers, name, value) {
  if (value === undefined || hasHeader(headers, name))
    return headers;

  return {
    ...headers,
    [name]: value
  };
}

/**
 * Format a deprecation sunset value for the HTTP Sunset header.
 *
 * @param {string|undefined} sunset
 * @returns {string|undefined}
 */
function sunsetHeaderValue(sunset) {
  if (!sunset)
    return undefined;

  let time = Date.parse(sunset);

  if (Number.isNaN(time))
    return undefined;

  return new Date(time).toUTCString();
}

/**
 * Infer the successor target used by the Link header.
 *
 * Structured replacements use their path. String replacements may be a URL,
 * path, or readable operation text such as `POST /sdk/screenshots/batch`.
 *
 * @param {string|{ path?: string }|undefined} replacement
 * @returns {string|undefined}
 */
function replacementLinkTarget(replacement) {
  if (!replacement)
    return undefined;

  if (typeof replacement === 'object')
    return replacement.path;

  if (/^https?:\/\//.test(replacement) || replacement.startsWith('/'))
    return replacement;

  let pathMatch = replacement.match(/\s(\/\S+)$/);
  return pathMatch?.[1];
}

/**
 * Build the RFC-style successor Link header for a deprecated endpoint.
 *
 * @param {{ replacement?: string|object }} deprecation
 * @returns {string|undefined}
 */
function deprecationLinkHeader(deprecation) {
  let target = replacementLinkTarget(deprecation.replacement);

  if (!target)
    return undefined;

  return `<${target}>; rel="successor-version"`;
}

/**
 * Add opt-in deprecation response headers while preserving explicit handler headers.
 *
 * @param {object} response
 * @param {object|undefined} deprecation
 * @returns {object}
 */
function applyDeprecationHeaders(response, deprecation) {
  if (deprecation?.headers !== true)
    return response;

  let headers = response?.headers ?? {};

  headers = withDefaultHeader(headers, 'Deprecation', 'true');
  headers = withDefaultHeader(headers, 'Sunset', sunsetHeaderValue(deprecation.sunset));
  headers = withDefaultHeader(headers, 'Link', deprecationLinkHeader(deprecation));

  return {
    ...response,
    headers
  };
}

/**
 * Return route event metadata for deprecated endpoints.
 *
 * @param {object} endpoint
 * @returns {{ deprecation?: object }}
 */
function deprecationMetadata(endpoint) {
  return endpoint.deprecation ? { deprecation: endpoint.deprecation } : {};
}

/**
 * Compose request middleware while counting only each middleware's own work.
 *
 * Middleware wraps the rest of the request, so naive duration tracking would
 * double-count downstream route/handler time. The wrapped `next()` subtracts
 * downstream time and keeps the middleware bucket useful.
 *
 * @param {Function[]} middleware
 * @param {Function} finalHandler
 * @param {object} [timing]
 * @returns {Function}
 */
function composeMiddleware(middleware, finalHandler, timing) {
  return middleware.reduceRight(
    (next, use) => async requestContext => {
      if (!timing)
        return await use(requestContext, next);

      let downstreamMs = 0;
      let wrappedNext = async nextRequestContext => {
        let start = performance.now();

        try {
          return await next(nextRequestContext);
        } finally {
          downstreamMs += performance.now() - start;
        }
      };
      let start = performance.now();

      try {
        return await use(requestContext, wrappedNext);
      } finally {
        timing.add('middlewareMs', Math.max(0, performance.now() - start - downstreamMs));
      }
    },
    finalHandler
  );
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Record small request lifecycle timings with a monotonic clock.
 *
 * These numbers are intentionally sparse. They explain where time went without
 * becoming a profiler, storage backend, or source of request/body data.
 *
 * @returns {{add: Function, startedAt: number, snapshot: Function, time: Function}}
 */
function createTimingRecorder() {
  let startedAt = performance.now();
  let phases = {};

  function add(name, value) {
    phases[name] = roundMs((phases[name] ?? 0) + value);
  }

  function time(name, action) {
    let start = performance.now();

    try {
      let result = action();

      if (result?.then)
        return result.finally(() => add(name, performance.now() - start));

      add(name, performance.now() - start);
      return result;
    } catch (error) {
      add(name, performance.now() - start);
      throw error;
    }
  }

  function snapshot(terminalName) {
    let totalMs = roundMs(performance.now() - startedAt);

    return {
      ...phases,
      ...(terminalName ? {
        [terminalName]: totalMs
      } : {}),
      totalMs
    };
  }

  return {
    add,
    startedAt,
    snapshot,
    time
  };
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

function logRuntimeEvent(logger, level, event, metadata) {
  try {
    logger[level](event, metadata);
  } catch {
    // Logging must never create a response failure path.
  }
}

function baseContextFor({
  logger,
  services,
  setup,
  trace
}) {
  return {
    ...setup.dependencies,
    logger,
    services,
    trace
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
    services: baseContext.services,
    trace: baseContext.trace
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

function safeErrorSnapshot(error) {
  return {
    code: error?.code,
    name: error?.name
  };
}

/**
 * Attach terminal response logging after Cricket has a concrete response.
 *
 * Finish and close are observed at the Node response boundary so traces can
 * distinguish completed responses from client disconnects without changing how
 * handlers return response objects.
 *
 * @param {object} options
 * @returns {{onFinish: Function, onClose: Function}}
 */
function observeResponse({
  logger,
  replay,
  request,
  requestId,
  response,
  route,
  timing
}) {
  let finished = false;

  function eventFor(terminalName) {
    return {
      requestId,
      request: safeRequestSnapshot(request),
      response: safeResponseSnapshot(response, {
        method: request.method
      }),
      route,
      terminal: true,
      timings: timing?.snapshot(terminalName)
    };
  }

  return {
    onFinish() {
      finished = true;
      let event = eventFor('finishMs');

      logRuntimeEvent(logger, 'info', 'http.response.finished', event);

      if (!replay)
        return;

      void replay.emit({
        ...event,
        type: 'response.finished'
      });
    },

    onClose() {
      if (finished)
        return;

      let event = eventFor('closeMs');

      logRuntimeEvent(logger, 'warn', 'http.response.closed', event);

      if (!replay)
        return;

      void replay.emit({
        ...event,
        type: 'response.closed'
      });
    }
  };
}

function writeObservedResponse(req, res, response, {
  logger,
  replay,
  request,
  requestId,
  route,
  timing
}) {
  let observer = observeResponse({
    logger,
    replay,
    request,
    requestId,
    response,
    route,
    timing
  });

  res.once('finish', observer.onFinish);
  res.once('close', observer.onClose);

  try {
    let write = () => writeHttpResponse(req, res, response);

    if (timing)
      timing.time('responseMs', write);
    else
      write();
  } catch (error) {
    res.off('finish', observer.onFinish);
    res.off('close', observer.onClose);
    throw error;
  }
}

async function emitObserved(observability, replay, createEvent) {
  if (!observability.enabled)
    return;

  await replay.emit(createEvent());
}

async function reportRequestError(appContract, {
  baseRequest,
  error,
  logger,
  response
}) {
  try {
    logger.error('request.failed', {
      error: safeErrorSnapshot(error),
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
        error: safeErrorSnapshot(onErrorFailure),
        originalError: safeErrorSnapshot(error),
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
  observability,
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
    let replay = observability.createReplay();
    let timing = createTimingRecorder();
    let requestId;
    let requestLogger = logger;
    let trace = createNoopTrace();
    let observedRequest;
    let route;

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
      requestId = observability.requestId({
        app: appContract,
        request: baseRequest
      });
      baseRequest = {
        ...baseRequest,
        id: requestId
      };
      observedRequest = baseRequest;
      requestLogger = logger.child({
        requestId
      });
      logRuntimeEvent(requestLogger, 'info', 'http.request.started', {
        request: safeRequestSnapshot(baseRequest)
      });
      await emitObserved(observability, replay, () => ({
        type: 'request.started',
        requestId,
        request: safeRequestSnapshot(baseRequest)
      }));
      assertAllowedHost(baseRequest, appContract.allowedHosts);

      if (!supportedEndpointMethods.includes(baseRequest.method.toUpperCase())) {
        writeObservedResponse(
          req,
          res,
          methodNotAllowed(baseRequest, supportedEndpointMethods),
          {
            replay,
            request: baseRequest,
            requestId,
            timing
          }
        );
        return;
      }

      if (baseRequest.method.toUpperCase() === 'OPTIONS' && baseRequest.path === '*') {
        writeObservedResponse(req, res, optionsResponse(supportedEndpointMethods), {
          replay,
          request: baseRequest,
          requestId,
          timing
        });
        return;
      }

      trace = createTrace({
        logger: requestLogger,
        replay,
        requestId,
        startedAt: timing.startedAt
      });
      let context = baseContextFor({
        logger: requestLogger,
        services,
        setup,
        trace
      });
      let requestContext = {
        app: appContract,
        context,
        logger: requestLogger,
        request: baseRequest,
        services,
        trace
      };
      let finalHandler = async nextRequestContext => {
        observedRequest = nextRequestContext.request;
        let match = await timing.time('routeMatchMs', () =>
          matchRoute(routes, nextRequestContext.request)
        );

        if (match) {
          let matchedRequest = withMatchedParams(nextRequestContext.request, match);
          observedRequest = matchedRequest;
          route = routeIdentityFor(match.endpoint);
          let routeLogger = requestLogger.child({
            route
          });
          let routeTrace = trace.child({
            route
          });
          requestLogger = routeLogger;
          logRuntimeEvent(routeLogger, 'info', 'http.route.matched', {
            request: safeRequestSnapshot(matchedRequest),
            route,
            ...deprecationMetadata(match.endpoint)
          });
          await emitObserved(observability, replay, () => ({
            type: 'route.matched',
            requestId,
            request: safeRequestSnapshot(matchedRequest),
            route,
            ...deprecationMetadata(match.endpoint)
          }));
          let matchedRequestContext = {
            ...nextRequestContext,
            context: {
              ...nextRequestContext.context,
              logger: routeLogger,
              trace: routeTrace
            },
            logger: routeLogger,
            trace: routeTrace
          };
          let requestContextForMatchedRequest = await timing.time('contextMs', () =>
            resolveRequestContext(appContract, matchedRequestContext, {
              request: matchedRequest,
              setup
            })
          );

          writeContinue();

          let parsedRequest = await timing.time(
            'bodyMs',
            () => completeRequestBody(
              req,
              requestContextForMatchedRequest.request,
              match.endpoint
            )
          );

          let response = await match.endpoint.handle(parsedRequest, requestContextForMatchedRequest.context, {
            timing
          });

          return applyDeprecationHeaders(response, match.endpoint.deprecation);
        }

        let allowedMethods = await timing.time('routeMatchMs', () =>
          allowedMethodsForPath(routes, nextRequestContext.request)
        );

        if (allowedMethods.length && nextRequestContext.request.method.toUpperCase() === 'OPTIONS')
          return optionsResponse(allowedMethods);

        if (allowedMethods.length)
          return methodNotAllowed(nextRequestContext.request, allowedMethods);

        let requestContextForRequest = await timing.time('contextMs', () =>
          resolveRequestContext(appContract, nextRequestContext, {
            setup
          })
        );
        observedRequest = requestContextForRequest.request;

        if (appContract.fallback)
          return await timing.time('fallbackMs', () =>
            appContract.fallback(requestContextForRequest)
          );

        return defaultNotFound(requestContextForRequest.request);
      };
      let response = await composeMiddleware(use, finalHandler, timing)(requestContext);

      writeObservedResponse(req, res, response, {
        logger: requestLogger,
        replay,
        request: observedRequest,
        requestId,
        route,
        timing
      });
    } catch (error) {
      let response = toHttpError(error);

      await reportRequestError(appContract, {
        baseRequest,
        error,
        logger: requestLogger,
        response
      });

      if (baseRequest) {
        await emitObserved(observability, replay, () => ({
          type: 'request.failed',
          error: safeErrorSnapshot(error),
          requestId,
          request: safeRequestSnapshot(observedRequest ?? baseRequest),
          route
        }));
      }

      writeObservedResponse(req, res, response, {
        logger: requestLogger,
        replay,
        request: observedRequest ?? baseRequest ?? {},
        requestId,
        route,
        timing
      });
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
 *   observability: object,
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
  let logger = resolveLogger(runtimeLogger ?? appContract.logger, {
    service: appContract.name ?? 'Cricket app'
  });
  let observability = normalizeObservability(appContract.observability, {
    logger
  });
  let setup = normalizeSetupResult(
    appContract.setup ? await appContract.setup({
      app: appContract,
      logger,
      trace: createNoopTrace()
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
    observability,
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
    observability,
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
