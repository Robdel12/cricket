let noop = () => {};
let levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
let sensitiveKeyPattern = /authorization|cookie|password|secret|set-cookie|token/i;
let loggerConfigKeys = new Set([
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

function routeName(route) {
  if (!route)
    return undefined;

  if (typeof route === 'string')
    return route;

  return route.operationId ?? route.path;
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

function formatLine(envelope, format) {
  if (format === 'pretty') {
    let summary = [
      envelope.time,
      envelope.level.toUpperCase(),
      envelope.service,
      envelope.requestId,
      routeName(envelope.route),
      envelope.event
    ].filter(Boolean).join(' ');

    return `${summary} ${JSON.stringify(envelope.metadata)}`;
  }

  return JSON.stringify(envelope);
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
 * Create Cricket's small structured logger.
 *
 * The logger writes newline-delimited events to stdout by default. Apps can
 * provide a custom `write()` function for tests or deployment plumbing.
 *
 * @param {object} [options={}]
 * @param {string} [options.service] - Stable service name attached to each log.
 * @param {'debug'|'info'|'warn'|'error'} [options.level='info'] - Minimum level.
 * @param {'json'|'pretty'} [options.format='json'] - Output format.
 * @param {Function} [options.write] - Receives each formatted line.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createCricketLogger({
  service,
  level = 'info',
  format = 'json',
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

    write(formatLine(envelope, format));
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
