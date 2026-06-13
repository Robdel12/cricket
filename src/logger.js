let noop = () => {};

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
