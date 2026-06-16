let noop = () => {};
let levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
let sensitiveKeyPattern = /authorization|cookie|password|secret|set-cookie|token/i;

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

function safeMetadata(value, seen = new WeakSet()) {
  if (value instanceof Error)
    return serializeError(value);

  if (!value || typeof value !== 'object')
    return value;

  if (seen.has(value))
    return '[Circular]';

  seen.add(value);

  if (Array.isArray(value))
    return value.map(item => safeMetadata(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[Redacted]' : safeMetadata(child, seen)
    ])
  );
}

function logEnvelope({
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

    write(formatLine(envelope, format), envelope);
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
      return createCricketLogger({
        service,
        level,
        format,
        write
      }, {
        ...context,
        ...metadata
      });
    }
  };
}
