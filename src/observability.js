import { randomUUID } from 'node:crypto';

import { frozenPlain } from './immutable.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function observerListFrom(config) {
  if (typeof config === 'function')
    return [config];

  return toArray(config?.observe);
}

function freezeEvent(event) {
  return frozenPlain({
    timestamp: new Date().toISOString(),
    ...event
  });
}

function safeFailure(error) {
  return {
    name: error?.name,
    message: error?.message
  };
}

let maxPendingExports = 256;

function createEventExporter(send, logger) {
  let pending = [];
  let running = false;
  let closed = false;

  async function sendBatch() {
    for (let remaining = pending.length; remaining > 0 && pending.length; remaining--) {
      let event = pending.shift();

      try {
        await send(event);
      } catch (error) {
        if (closed)
          return;

        try {
          logger?.error?.('observability.export_failed', { event: event.type, name: error?.name });
        } catch {
          // Export failures must stay outside the runtime path.
        }
      }
    }

    if (pending.length)
      setImmediate(sendBatch);
    else
      running = false;
  }

  return {
    enqueue(event) {
      if (closed || pending.length >= maxPendingExports)
        return;

      pending.push(event);

      if (!running) {
        running = true;
        setImmediate(sendBatch);
      }
    },

    close() {
      closed = true;
      pending.length = 0;
    }
  };
}

let noopReplay = Object.freeze({
  async emit() {}
});

/**
 * Normalize app observability config into Cricket's event emitter shape.
 *
 * Apps observe immutable lifecycle events. Observers are awaited and their
 * errors are logged. Exporters receive the same events without replay, on a
 * bounded queue outside request and job completion.
 *
 * @param {Function|object|undefined} config - Observability config or observer.
 * @param {object} options
 * @param {object} options.logger - Cricket logger.
 * @returns {{enabled: boolean, requestId: Function, createReplay: Function, emit: Function, close: Function|undefined}}
 */
export function normalizeObservability(config, {
  logger
} = {}) {
  let observers = observerListFrom(config);
  let requestId = typeof config?.requestId === 'function'
    ? config.requestId
    : randomUUID;

  let sendEvent = config?.export;
  if (sendEvent !== undefined && typeof sendEvent !== 'function')
    throw new Error('observability.export must be a function');

  let exporter = sendEvent ? createEventExporter(sendEvent, logger) : undefined;
  let enabled = observers.length > 0 || Boolean(exporter);

  async function notifyObservers(observed, context) {
    for (let observe of observers) {
      try {
        await observe(observed, context);
      } catch (error) {
        try {
          logger?.error?.('observability.failed', {
            error: safeFailure(error),
            event: observed.type,
            requestId: observed.requestId
          });
        } catch {
          // Observability failures must not create another failure path.
        }
      }
    }
  }

  async function emit(event, context) {
    if (!enabled)
      return;

    let observed = freezeEvent(event);
    exporter?.enqueue(observed);
    if (observers.length)
      await notifyObservers(observed, context);
  }

  function createReplay(requestContext) {
    if (!observers.length)
      return exporter ? { emit } : noopReplay;

    let events = [];
    let context = requestContext === undefined
      ? undefined
      : Object.freeze({ logger: requestContext.logger, services: requestContext.services });

    return {
      async emit(event) {
        let replayEvent = freezeEvent(event);
        events.push(replayEvent);

        exporter?.enqueue(replayEvent);
        await notifyObservers(Object.freeze({
          ...replayEvent,
          replay: event.terminal ? Object.freeze([...events]) : undefined
        }), context);
      }
    };
  }

  return {
    enabled,
    requestId,
    createReplay,
    emit,
    close: exporter?.close
  };
}
