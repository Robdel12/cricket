import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { supportedEndpointMethods } from '../endpoint.js';
import {
  apiVersionLogMetadata,
  applyApiVersionHeaders,
  resolveEndpointApiVersion
} from '../api-version.js';
import {
  isMainModule,
  resolveCricketApp
} from '../app.js';
import { createServices } from '../domain.js';
import {
  expectationFailed,
  toHttpError
} from '../errors.js';
import { isPlainObject } from '../immutable.js';
import { resolveLogger } from '../logger.js';
import { normalizeObservability } from '../observability.js';
import { assertKnownOptions } from '../options.js';
import { createDatabaseConnection } from '../persistence/database.js';
import { bindPluginServices } from '../plugin.js';
import { applyRules } from '../rule.js';
import {
  createNoopTrace,
  createTrace
} from '../trace.js';
import { routeIdentityFor } from '../route-identity.js';
import {
  getResponseError,
  resolveHttpResponse,
  respond,
  withHeaders
} from '../response.js';
import {
  assertAllowedHost,
  completeRequestBody,
  createBaseRequest,
  safeRequestSnapshot
} from './request.js';
import { createRuntimeLifecycle } from './lifecycle.js';
import { createRequestTracker } from './requests.js';
import { closeServer, listen, serverOrigin } from './server.js';
import {
  allowedMethodsForPath,
  endpointWithPrefix,
  joinPaths,
  matchRoute,
  prepareRoutes
} from './router.js';
import {
  createResponseWriter,
  safeResponseSnapshot
} from './response.js';

let lifecycleControllerKey = Symbol('cricket.lifecycleController');
let setupResultKeys = new Set([
  'cleanup',
  'dependencies',
  'services'
]);

function throwFailures(errors, message) {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, message);
}

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function normalizeSetupResult(result) {
  if (result === undefined)
    return {
      dependencies: {},
      services: {},
      cleanup: undefined
    };

  if (!isPlainObject(result))
    throw new Error('setup must return { dependencies, services, cleanup } or undefined');

  assertKnownOptions(result, setupResultKeys, 'setup');

  let dependencies = result.dependencies === undefined ? {} : result.dependencies;
  let services = result.services === undefined ? {} : result.services;

  if (!isPlainObject(dependencies))
    throw new Error('setup dependencies must be a plain object');

  if (!isPlainObject(services))
    throw new Error('setup services must be a plain object');

  if (result.cleanup !== undefined && typeof result.cleanup !== 'function')
    throw new Error('setup cleanup must be a function');

  return {
    dependencies,
    services,
    cleanup: result.cleanup
  };
}

async function cleanupRuntime(setupCleanup, db) {
  let errors = [];
  for (let cleanup of [setupCleanup, db && (() => db.destroy())]) {
    try {
      await cleanup?.();
    } catch (error) {
      errors.push(error);
    }
  }
  throwFailures(errors, 'Runtime cleanup failed');
}

function setupDependenciesFor(setup, db) {
  if (!db)
    return setup;

  if (Object.hasOwn(setup.dependencies, 'db'))
    throw new Error('setup dependencies must not include db when database is configured');

  return {
    ...setup,
    dependencies: {
      db,
      ...setup.dependencies
    },
    cleanup: () => cleanupRuntime(setup.cleanup, db)
  };
}

function setupWithLifecycleCleanup(setup, lifecycleController, requests) {
  let cleaning;
  return {
    ...setup,
    cleanup() {
      if (cleaning) return cleaning;
      requests.stop();
      lifecycleController.shuttingDown();
      cleaning = (async () => {
        let errors = [];
        for (let cleanup of [requests.idle, setup.cleanup]) {
          try {
            await cleanup?.();
          } catch (error) {
            errors.push(error);
          }
        }
        lifecycleController.stopped();
        throwFailures(errors, 'Runtime cleanup failed');
      })();
      return cleaning;
    }
  };
}

async function resolveMiddleware(middleware, runtime) {
  let value = typeof middleware === 'function'
    ? await middleware(runtime)
    : middleware;

  return toArray(value);
}

function defaultNotFound(request) {
  return respond(404, {
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.path}`
      }
  });
}

function methodNotAllowed(request, allowedMethods) {
  return withHeaders(
    respond(405, {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${request.method} is not allowed for ${request.path}`
      }
    }),
    {
      Allow: allowedMethods.join(', ')
    }
  );
}

function optionsResponse(allowedMethods) {
  return withHeaders(respond(204), {
      Allow: allowedMethods.join(', ')
  });
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
 * Add a framework response header unless the handler already set it.
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

  return withHeaders(response, headers);
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
    (next, runMiddleware) => async requestContext => {
      if (!timing)
        return await runMiddleware(requestContext, next);

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
        return await runMiddleware(requestContext, wrappedNext);
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
  function serve(req, res, options) {
    // An accepted keep-alive response can become idle after close() starts.
    res.once('finish', () => {
      if (!server.listening)
        queueMicrotask(() => server.closeIdleConnections());
    });
    return handle(req, res, options);
  }
  let server = http.createServer(serve);

  server.on('checkContinue', (req, res) => {
    void serve(req, res, {
      expectContinue: true
    });
  });
  server.on('checkExpectation', (req, res) => {
    void serve(req, res, { unsupportedExpectation: true });
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
  lifecycle,
  logger,
  services,
  setup,
  trace
}) {
  return {
    ...setup.dependencies,
    lifecycle,
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
    lifecycle: baseContext.lifecycle,
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
 * Start response writing and retain its terminal logging and observer work.
 *
 * Finish and close are observed at the Node response boundary so traces can
 * distinguish completed responses from client disconnects without changing how
 * handlers return response objects.
 *
 */
function writeObservedResponse(writer, response, {
  logger,
  replay,
  request,
  requestId,
  route,
  timing
}) {
  let onTerminal = async kind => {
    let finished = kind === 'finished';
    let event = {
      requestId,
      request: safeRequestSnapshot(request),
      response: safeResponseSnapshot(response, {
        method: request.method
      }),
      route,
      terminal: true,
      timings: timing?.snapshot(finished ? 'finishMs' : 'closeMs')
    };
    logRuntimeEvent(logger, finished ? 'info' : 'warn', `http.response.${kind}`, event);
    await replay?.emit({ ...event, type: `response.${kind}` });
  };

  let write = () => writer.write(response, { onTerminal });
  if (timing)
    timing.time('responseMs', write);
  else
    write();
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
  response,
  route,
  handled = false,
  phase = 'request',
  reportedErrors
}) {
  let phases = reportedErrors?.get(error);
  if (phases?.has(phase))
    return;
  phases ??= new Set();
  phases.add(phase);
  reportedErrors?.set(error, phases);
  try {
    logger.error('request.failed', {
      error: safeErrorSnapshot(error),
      ...(handled ? { handled: true } : {}),
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
      response,
      logger,
      route,
      handled,
      phase
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
  lifecycle,
  logger,
  observability,
  routes,
  setup,
  services,
  middleware,
  requests
}) {
  async function execute(req, res, writer, completionContext, {
    expectContinue = false,
    unsupportedExpectation = false
  }) {
    let baseRequest;
    let continued = false;
    let replay = observability.createReplay();
    let timing = createTimingRecorder();
    let requestId;
    let requestLogger = logger;
    let trace = createNoopTrace();
    let observedRequest;
    let route;
    let routeEndpoint;
    let apiVersionNegotiation;

    async function reportFailure(error, response, handled = false) {
      await reportRequestError(appContract, {
        baseRequest,
        error,
        logger: requestLogger,
        response,
        route,
        handled,
        reportedErrors: completionContext.reportedErrors
      });

      if (baseRequest) {
        await emitObserved(observability, replay, () => ({
          type: 'request.failed',
          error: safeErrorSnapshot(error),
          ...(handled ? { handled: true } : {}),
          requestId,
          request: safeRequestSnapshot(observedRequest ?? baseRequest),
          route
        }));
      }
    }

    function writeResponse(response, observation) {
      writeObservedResponse(writer, response, observation);
      completionContext.response = response;
    }

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
      Object.assign(completionContext, { baseRequest, logger: requestLogger });
      logRuntimeEvent(requestLogger, 'info', 'http.request.started', {
        request: safeRequestSnapshot(baseRequest)
      });
      await emitObserved(observability, replay, () => ({
        type: 'request.started',
        requestId,
        request: safeRequestSnapshot(baseRequest)
      }));
      assertAllowedHost(baseRequest, appContract.allowedHosts);

      if (unsupportedExpectation) {
        writeResponse(toHttpError(expectationFailed()), {
          logger: requestLogger, replay, request: baseRequest, requestId, timing
        });
        return;
      }

      if (!supportedEndpointMethods.includes(baseRequest.method.toUpperCase())) {
        writeResponse(
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
        writeResponse(optionsResponse(supportedEndpointMethods), {
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
        lifecycle,
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
          routeEndpoint = match.endpoint;
          route = routeIdentityFor(routeEndpoint);
          apiVersionNegotiation = resolveEndpointApiVersion(routeEndpoint, matchedRequest);
          let versionMetadata = apiVersionLogMetadata(apiVersionNegotiation);
          let routeLogger = requestLogger.child({
            route,
            ...versionMetadata
          });
          let routeTrace = trace.child({
            route,
            ...versionMetadata
          });
          requestLogger = routeLogger;
          Object.assign(completionContext, { logger: routeLogger, route });
          if (apiVersionNegotiation)
            logRuntimeEvent(routeLogger, 'info', 'http.api_version.resolved', versionMetadata);
          logRuntimeEvent(routeLogger, 'info', 'http.route.matched', {
            request: safeRequestSnapshot(matchedRequest),
            route,
            ...versionMetadata,
            ...deprecationMetadata(routeEndpoint)
          });
          await emitObserved(observability, replay, () => ({
            type: 'route.matched',
            requestId,
            request: safeRequestSnapshot(matchedRequest),
            route,
            ...versionMetadata,
            ...deprecationMetadata(routeEndpoint)
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

          let contextAfterBeforeBodyRules = await timing.time('beforeBodyRulesMs', () =>
            applyRules(match.endpoint.beforeBodyRules, {
              ...requestContextForMatchedRequest.context,
              ...(apiVersionNegotiation ? {
                apiVersion: apiVersionNegotiation.version
              } : {}),
              request: requestContextForMatchedRequest.request
            })
          );

          writeContinue();

          let parsedRequest;
          try {
            parsedRequest = await timing.time(
              'bodyMs',
              () => completeRequestBody(
                req,
                requestContextForMatchedRequest.request,
                routeEndpoint
              )
            );
            observedRequest = parsedRequest;

            let response = await routeEndpoint.handle(parsedRequest, contextAfterBeforeBodyRules, {
              apiVersionNegotiation,
              timing
            });

            return applyDeprecationHeaders(response, routeEndpoint.deprecation);
          } finally {
            await parsedRequest?.cleanup?.();
          }
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
      let result = await composeMiddleware(middleware, finalHandler, timing)(requestContext);
      let response = resolveHttpResponse(result);
      response = applyApiVersionHeaders(response, routeEndpoint, apiVersionNegotiation);

      let error = getResponseError(response);
      if (error !== undefined)
        await reportFailure(error, response, true);

      writeResponse(response, {
        logger: requestLogger,
        replay,
        request: observedRequest,
        requestId,
        route,
        timing
      });
    } catch (error) {
      let response = toHttpError(error);

      response = applyApiVersionHeaders(response, routeEndpoint, apiVersionNegotiation);

      await reportFailure(error, response);

      writeResponse(response, {
        logger: requestLogger,
        replay,
        request: observedRequest ?? baseRequest ?? {},
        requestId,
        route,
        timing
      });
    }
  }

  return function handle(req, res, options = {}) {
    let writer = createResponseWriter(req, res);
    let execution = requests.run(async () => {
      let errors = [];
      let completionContext = { logger, reportedErrors: new Map() };
      try {
        await execute(req, res, writer, completionContext, options);
      } catch (error) {
        errors.push(error);
        res.destroy();
      }

      // Once writing starts, async failures can only be reported and drained.
      try {
        await writer.complete();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        let error = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Request completion failed');
        await reportRequestError(appContract, { ...completionContext, error, phase: 'response' });
        throw error;
      }
    });

    if (execution)
      return execution;

    // Paused requests never enter middleware, handlers, or the accepted set.
    writer.write(respond(503, {
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The app is not accepting requests.' }
    }));
    return writer.complete().catch(error => {
      logRuntimeEvent(logger, 'error', 'http.response.failed', { error: safeErrorSnapshot(error) });
    });
  };
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
 *   lifecycle: object,
 *   logger: object,
 *   observability: object,
 *   requests: { pause: Function },
 *   services: object,
 *   cleanup: Function
 * }>} Runtime object with handler and context.
 */
export async function createCricketRuntime(cricketApp, {
  baseUrl,
  logger: runtimeLogger
} = {}) {
  let lifecycleController = createRuntimeLifecycle();
  let requests = createRequestTracker();
  let { lifecycle } = lifecycleController;
  let appContract = await resolveCricketApp(cricketApp, {
    baseUrl
  });
  let logger = resolveLogger(runtimeLogger ?? appContract.logger, {
    service: appContract.name ?? 'Cricket app'
  });
  let observability = normalizeObservability(appContract.observability, {
    logger
  });
  let db = appContract.database
    ? createDatabaseConnection(appContract.database, {
      baseUrl
    })
    : undefined;
  let setup;

  try {
    setup = setupDependenciesFor(
      normalizeSetupResult(
        appContract.setup ? await appContract.setup({
          app: appContract,
          db,
          lifecycle,
          logger,
          trace: createNoopTrace()
        }) : undefined
      ),
      db
    );
    setup = setupWithLifecycleCleanup(setup, lifecycleController, requests);
  } catch (error) {
    let errors = [error];
    try {
      if (db)
        await db.destroy();
    } catch (cleanupError) {
      errors.push(cleanupError);
    } finally {
      lifecycleController.stopped();
    }
    throwFailures(errors, 'Runtime setup failed');
  }

  try {
    let domainServices = createServices(appContract.domains, {
      ...setup.dependencies,
      lifecycle,
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
        lifecycle,
        logger,
        services: defaultServices
      });
    } else if (appContract.services) {
      services = appContract.services;
    }

    services = bindPluginServices(appContract.plugins, services);

    let runtimeBag = {
      app: appContract,
      dependencies: setup.dependencies,
      domainServices,
      lifecycle,
      logger,
      services
    };
    let middleware = await resolveMiddleware(appContract.middleware, runtimeBag);
    let prefixedEndpoints = appContract.endpoints.map(endpoint =>
      endpointWithPrefix(endpoint, appContract.prefix)
    );
    let routes = prepareRoutes(prefixedEndpoints);
    let handle = createRuntimeHandler({
      appContract,
      lifecycle,
      logger,
      observability,
      routes,
      setup,
      services,
      middleware,
      requests
    });
    let app = Object.assign(handle, {
      handle,
      listen(...args) {
        let server = createNodeServer(handle, logger);
        return server.listen(...args);
      }
    });
    let runtime = {
      app,
      contract: appContract,
      dependencies: setup.dependencies,
      handle,
      lifecycle,
      logger,
      observability,
      requests: requests.requests,
      services,
      cleanup: setup.cleanup
    };

    Object.defineProperty(runtime, lifecycleControllerKey, {
      value: { ...lifecycleController, requests }
    });
    lifecycleController.ready();

    return runtime;
  } catch (error) {
    let errors = [error];
    try {
      await setup.cleanup();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    throwFailures(errors, 'Runtime setup failed');
  }
}

/**
 * Start a Cricket app as a standalone HTTP server.
 *
 * Creates the runtime and starts listening on the specified port. Only runs when
 * the module is the main entrypoint (checked via `main` parameter).
 * Resolves after binding succeeds. `origin` uses the bound port, including port 0.
 * `stop()` closes admission, runs onShutdown, drains accepted requests, then
 * releases dependencies. Hooks must stop producers and end long-lived streams.
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
 *   lifecycle: object,
 *   logger: object,
 *   server: object,
 *   origin: string,
 *   requests: { pause: Function },
 *   services: object,
 *   cleanup: Function,
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
  let server;
  try {
    server = await listen(runtime.app, { port, host });
  } catch (error) {
    let errors = [error];
    try {
      await runtime.cleanup();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    throwFailures(errors, 'Server startup failed');
  }
  let origin = serverOrigin(server);
  logRuntimeEvent(runtime.logger, 'info', 'server.started', {
    app: runtime.contract.name ?? 'Cricket app',
    port: server.address().port,
    url: origin
  });
  let stopping;

  function stop(signal, {
    closeConnections = 'idle'
  } = {}) {
    if (stopping) return stopping;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    let controller = runtime[lifecycleControllerKey];
    controller.requests.stop();
    controller.shuttingDown(signal);
    let closing = closeServer(server, { closeConnections });
    stopping = Promise.resolve().then(async () => {
      let errors = [];
      for (let cleanup of [
        () => runtime.contract.onShutdown?.({ signal, ...runtime }),
        controller.requests.idle,
        () => {
          server.closeIdleConnections();
          return closing;
        },
        runtime.cleanup
      ]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      throwFailures(errors, 'Server shutdown failed');
    });
    return stopping;
  }

  let shutdown = async signal => {
    try {
      await stop(signal);
      process.exit(0);
    } catch (error) {
      logRuntimeEvent(runtime.logger, 'error', 'server.shutdown.failed', { error: safeErrorSnapshot(error) });
      process.exit(1);
    }
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
    origin,
    server,
    stop
  };
}
