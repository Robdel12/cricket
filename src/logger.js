import { formatPrettyLog } from './pretty-log.js';

let noop = () => {};
let levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
let sensitiveKeyPattern = /authorization|cookie|password|secret|set-cookie|token/i;
let loggerConfigKeys = new Set([
  'color',
  'format',
  'level',
  'service',
  'write'
]);

function callLogger(logger, level, event, metadata) {
  if (typeof logger === 'function')
    return logger(event, metadata);

  let method = logger?.[level] ?? logger?.log ?? noop;
  method.call(logger, event, metadata);
}

function normalizeLogInput(event, metadata) {
  if (typeof event === 'object' && typeof metadata === 'string') {
    return {
      event: metadata,
      metadata: event
    };
  }

  return {
    event,
    metadata
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message
  };
}

/**
 * Serialize log metadata without leaking obvious secrets or crashing on cycles.
 *
 * Cricket logs are meant to be safe by default for stdout/docker collection, so
 * nested app metadata is copied into a redacted envelope before it is written.
 *
 * @param {any} value
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
function safeMetadata(value, seen = new WeakSet()) {
  if (value instanceof Error)
    return serializeError(value);

  if (!value || typeof value !== 'object')
    return value;

  if (seen.has(value))
    return '[Circular]';

  seen.add(value);

  if (Array.isArray(value)) {
    let safe = value.map(item => safeMetadata(item, seen));
    seen.delete(value);
    return safe;
  }

  let safe = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[Redacted]' : safeMetadata(child, seen)
    ])
  );

  seen.delete(value);
  return safe;
}

/** Build a structured log entry and redact sensitive metadata fields. */
export function logEnvelope({
  context,
  event,
  level,
  metadata,
  service
}) {
  let safe = safeMetadata({
    ...context,
    ...metadata
  });

  return {
    time: new Date().toISOString(),
    level,
    event,
    ...(service ? { service } : {}),
    ...(safe.requestId ? { requestId: safe.requestId } : {}),
    ...(safe.route ? { route: safe.route } : {}),
    ...(safe.span ? { span: safe.span } : {}),
    metadata: safe
  };
}

function hasLoggerMethod(logger) {
  return ['debug', 'info', 'warn', 'error', 'log', 'child']
    .some(method => typeof logger?.[method] === 'function');
}

function isCricketLoggerConfig(logger) {
  return Object.keys(logger).some(key => loggerConfigKeys.has(key));
}

function assertKnownLoggerConfig(config) {
  let unknown = Object.keys(config).filter(key => !loggerConfigKeys.has(key));

  if (unknown.length)
    throw new Error(`Unknown logger option ${unknown.join(', ')}`);
}

/**
 * Normalize app-provided logging into Cricket's small logger shape.
 *
 * @param {Function|object|undefined} logger - App logger, console-like object, or log function.
 * @param {object} [context={}] - Metadata attached by `child()`.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function normalizeLogger(logger, context = {}) {
  function write(level, event, metadata = {}) {
    let input = normalizeLogInput(event, metadata);

    callLogger(logger, level, input.event, {
      ...context,
      ...input.metadata
    });
  }

  return {
    debug(event, metadata) {
      write('debug', event, metadata);
    },

    info(event, metadata) {
      write('info', event, metadata);
    },

    warn(event, metadata) {
      write('warn', event, metadata);
    },

    error(event, metadata) {
      write('error', event, metadata);
    },

    child(metadata = {}) {
      let child = logger?.child;

      if (child)
        return normalizeLogger(child.call(logger, metadata), context);

      return normalizeLogger(logger, {
        ...context,
        ...metadata
      });
    }
  };
}

/**
 * @guide observability Follow a request
 *
 * When something goes wrong, you want to see what happened. Cricket logs every request with an ID, times the work you care about, and reports errors where you tell it to.
 *
 * ## Logging
 *
 * Set up the logger on the app. Pretty output is great locally, JSON is what your log collector wants.
 *
 * ```js
 * export let app = defineCricketApp({
 *   domains: './domains',
 *   logger: {
 *     service: 'projects-api',
 *     level: process.env.LOG_LEVEL ?? 'info',
 *     format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
 *   }
 * });
 * ```
 *
 * Setup, services, rules, handlers, and jobs all get the same `logger`. Log events with structured fields so you can filter on them later:
 *
 * ```js
 * logger.info('project.created', { projectId: project.id });
 * ```
 *
 * Cricket redacts fields that look like secrets, like `authorization`, `cookie`, `password`, and `token`.
 *
 * ## Tracing
 *
 * Wrap the slow or important bits in a span:
 *
 * ```js
 * let project = await trace.span('projects.find', { slug }, () => services.projects.findBySlug(slug));
 * ```
 *
 * Then pull one request's timeline out of your JSON logs:
 *
 * ```sh
 * docker logs api | pnpm exec cricket trace req_123
 * ```
 *
 * ## Reporting errors
 *
 * Give the app an `onError` hook to send failures to your error tracker. It gets the original exception plus the request, response, matched route, and logger.
 *
 * Using Sentry? There's an adapter:
 *
 * ```js
 * import { sentryErrorHandler } from '@robdel12/cricket/sentry';
 * import * as Sentry from '@sentry/node';
 *
 * export let app = defineCricketApp({
 *   domains: './domains',
 *   onError: sentryErrorHandler(Sentry),
 *   setup() {
 *     Sentry.init({ dsn: process.env.SENTRY_DSN });
 *     return { cleanup: () => Sentry.flush(2000) };
 *   }
 * });
 * ```
 *
 * It skips 4xx errors and adds the method, status, route, and request ID. It never sends headers, cookies, query strings, or bodies.
 *
 * ## Health checks
 *
 * Your app can read `lifecycle` to see if Cricket is starting, ready, or shutting down. But whether your product is healthy is your call, so write your own health route that checks what matters, like the database.
 */
/**
 * Create Cricket's small structured logger.
 *
 * The logger writes newline-delimited events to stdout by default. Apps can
 * provide a custom `write()` function for tests or deployment plumbing.
 *
 * @param {object} [options={}]
 * @param {string} [options.service] - Stable service name attached to each log.
 * @param {'debug'|'info'|'warn'|'error'} [options.level='info'] - Minimum level.
 * @param {'json'|'pretty'} [options.format='json'] - Output format.
 * @param {boolean} [options.color] - Pretty colors; defaults to stdout TTY detection and respects NO_COLOR.
 * @param {Function} [options.write] - Receives each formatted event, which may span lines in pretty mode.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createCricketLogger({
  service,
  level = 'info',
  format = 'json',
  color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
  write = line => console.log(line)
} = {}, context = {}) {
  let minimumLevel = levels[level] ?? levels.info;

  function log(nextLevel, event, metadata = {}) {
    if (levels[nextLevel] < minimumLevel)
      return;

    let input = normalizeLogInput(event, metadata);
    let envelope = logEnvelope({
      context,
      event: input.event,
      level: nextLevel,
      metadata: input.metadata,
      service
    });

    write(format === 'pretty' ? formatPrettyLog(envelope, { color }) : JSON.stringify(envelope));
  }

  return {
    debug(event, metadata) {
      log('debug', event, metadata);
    },

    info(event, metadata) {
      log('info', event, metadata);
    },

    warn(event, metadata) {
      log('warn', event, metadata);
    },

    error(event, metadata) {
      log('error', event, metadata);
    },

    child(metadata = {}) {
      let childContext = {
        ...context,
        ...metadata
      };

      return createCricketLogger({
        service,
        level,
        format,
        color,
        write
      }, childContext);
    }
  };
}

/**
 * Resolve runtime logger input into Cricket's logger shape.
 *
 * Omitted loggers become Cricket's structured stdout logger. Foreign loggers are
 * normalized at the edge. Plain Cricket logger config is passed to
 * `createCricketLogger()`.
 *
 * @param {Function|object|undefined} logger - Logger instance, function, config, or undefined.
 * @param {object} [defaults={}] - Default Cricket logger options.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function resolveLogger(logger, defaults = {}) {
  if (!logger)
    return createCricketLogger(defaults);

  if (typeof logger === 'object' && !hasLoggerMethod(logger)) {
    if (!isCricketLoggerConfig(logger))
      throw new Error('Logger config needs at least one known logger option');

    assertKnownLoggerConfig(logger);
    return createCricketLogger({
      ...defaults,
      ...logger
    });
  }

  return normalizeLogger(logger);
}
