import { randomUUID } from 'node:crypto';

import { deepFreeze } from './immutable.js';

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
  return deepFreeze({
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

let noopReplay = Object.freeze({
  async emit() {}
});

/**
 * Normalize app observability config into Cricket's event emitter shape.
 *
 * Apps observe immutable lifecycle events. Observer failures are reported to the
 * logger and never change the HTTP response path.
 *
 * @param {Function|object|undefined} config - Observability config or observer.
 * @param {object} options
 * @param {object} options.logger - Cricket logger.
 * @returns {{enabled: boolean, requestId: Function, createReplay: Function, emit: Function}}
 */
export function normalizeObservability(config, {
  logger
} = {}) {
  let observers = observerListFrom(config);
  let requestId = typeof config?.requestId === 'function'
    ? config.requestId
    : randomUUID;

  async function emit(event) {
    if (!observers.length)
      return;

    let observed = freezeEvent(event);

    for (let observe of observers) {
      try {
        await observe(observed);
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

  function createReplay() {
    if (!observers.length)
      return noopReplay;

    let events = [];

    return {
      async emit(event) {
        let replayEvent = freezeEvent(event);
        events.push(replayEvent);

        await emit({
          ...replayEvent,
          replay: event.terminal ? Object.freeze([...events]) : undefined
        });
      }
    };
  }

  return {
    enabled: observers.length > 0,
    requestId,
    createReplay,
    emit
  };
}
