import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

let noopTrace = Object.freeze({
  child() {
    return noopTrace;
  },

  async span(name, metadata, fn) {
    let callback = typeof metadata === 'function' ? metadata : fn;
    return await callback?.(noopTrace);
  }
});
let sensitiveKeyPattern = /authorization|cookie|password|secret|set-cookie|token/i;

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function safeError(error) {
  return {
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.name ? { name: error.name } : {})
  };
}

function safeAttributes(metadata) {
  if (!metadata || typeof metadata !== 'object')
    return undefined;

  let attributes = {};

  for (let [key, value] of Object.entries(metadata)) {
    if (
      value !== null &&
      !['boolean', 'number', 'string'].includes(typeof value)
    )
      continue;

    attributes[key] = sensitiveKeyPattern.test(key) ? '[Redacted]' : value;
  }

  return Object.keys(attributes).length ? attributes : undefined;
}

/**
 * Create a no-op trace capability for non-request setup paths.
 *
 * @returns {{child: Function, span: Function}}
 */
export function createNoopTrace() {
  return noopTrace;
}

/**
 * Create Cricket's request-scoped trace capability.
 *
 * Spans are explicit app/workflow measurements. They emit safe structured logs
 * and observability events without changing callback return or error behavior.
 *
 * @param {object} options
 * @param {object} options.logger - Request-scoped Cricket logger.
 * @param {object} [options.replay] - Request replay emitter.
 * @param {string} options.requestId - Request id for trace correlation.
 * @param {object} [options.route] - Matched route identity.
 * @param {number} [options.startedAt] - Monotonic request start time.
 * @param {string} [options.parentId] - Parent span id.
 * @param {object} [options.context] - Safe child context.
 * @returns {{child: Function, span: Function}}
 */
export function createTrace({
  logger,
  replay,
  requestId,
  route,
  startedAt = performance.now(),
  parentId,
  context = {}
} = {}) {
  function child(metadata = {}) {
    return createTrace({
      logger,
      replay,
      requestId,
      route: metadata.route ?? route,
      startedAt,
      parentId,
      context: {
        ...context,
        ...safeAttributes(metadata)
      }
    });
  }

  async function emitSpan(span) {
    try {
      logger?.info?.('trace.span.finished', {
        requestId,
        route,
        span
      });
    } catch {
      // Trace sinks must never replace the app result or original error.
    }

    try {
      await replay?.emit?.({
        requestId,
        route,
        span,
        type: 'trace.span.finished'
      });
    } catch {
      // Observer/replay failures are already isolated by the runtime.
    }
  }

  async function span(name, metadata, fn) {
    let callback = typeof metadata === 'function' ? metadata : fn;
    let attributes = typeof metadata === 'function' ? undefined : safeAttributes(metadata);
    let id = randomUUID();
    let start = performance.now();
    let childTrace = createTrace({
      logger,
      replay,
      requestId,
      route,
      startedAt,
      parentId: id,
      context
    });
    let finish = (status, extra = {}) => ({
      id,
      parentId,
      name,
      startMs: roundMs(start - startedAt),
      durationMs: roundMs(performance.now() - start),
      status,
      ...extra,
      ...(attributes ? { attributes } : {}),
      ...(Object.keys(context).length ? { context } : {})
    });

    try {
      let result = await callback(childTrace);

      await emitSpan(finish('ok'));
      return result;
    } catch (error) {
      await emitSpan(finish('error', {
        error: safeError(error)
      }));
      throw error;
    }
  }

  return {
    child,
    span
  };
}
