import { randomUUID } from 'node:crypto';

function copyPlain(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object')
    return value;

  if (seen.has(value))
    return seen.get(value);

  if (Array.isArray(value)) {
    let copy = [];
    seen.set(value, copy);
    copy.push(...value.map(item => copyPlain(item, seen)));
    return copy;
  }

  let copy = {};
  seen.set(value, copy);

  for (let [key, child] of Object.entries(value))
    copy[key] = copyPlain(child, seen);

  return copy;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value))
    return value;

  seen.add(value);

  for (let child of Object.values(value))
    deepFreeze(child, seen);

  return Object.freeze(value);
}

function frozenPlain(value) {
  return deepFreeze(copyPlain(value));
}

function matchesFilter(value, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => value?.[key] === expected);
}

function boundedPush(items, value, limit) {
  items.push(value);

  while (items.length > limit)
    items.shift();
}

function spanFromEvent(event) {
  return {
    requestId: event.requestId,
    route: event.route,
    ...event.span
  };
}

function requestFromEvent(event) {
  return {
    requestId: event.requestId,
    route: event.route,
    request: event.request,
    response: event.response,
    timings: event.timings ?? {},
    replay: event.replay ?? []
  };
}

function requestRecords(eventItems) {
  return eventItems
    .filter(event => event.type === 'response.finished' || event.type === 'response.closed')
    .map(requestFromEvent);
}

function spanRecords(eventItems) {
  return eventItems
    .filter(event => event.type === 'trace.span.finished' && event.span)
    .map(spanFromEvent);
}

/**
 * @typedef {object} CricketTestState
 * @property {(event: object) => void} recordEvent - Store a Cricket lifecycle event.
 * @property {(log: object) => void} recordLog - Store a structured Cricket log.
 * @property {() => void} clear - Remove all retained events and logs.
 * @property {(filter?: object) => object[]} events - Retained lifecycle events.
 * @property {(filter?: object) => object[]} logs - Retained structured logs.
 * @property {(filter?: object) => object[]} requests - Terminal request records.
 * @property {(requestId: string) => object|undefined} request - One terminal request by id.
 * @property {(requestId: string) => object} trace - Request-correlated spans, logs, and events.
 * @property {() => object} report - JSON-safe run report.
 */

/**
 * Create an in-memory Cricket test collector.
 *
 * The collector stores safe runtime facts emitted by Cricket's HTTP lifecycle:
 * request events, structured logs, trace spans, and terminal request timings.
 *
 * @param {object} [options]
 * @param {number} [options.maxEvents=1000] - Maximum lifecycle events retained.
 * @param {number} [options.maxLogs=1000] - Maximum structured logs retained.
 * @returns {CricketTestState} Test state inspection API.
 */
export function createTestState({
  maxEvents = 1000,
  maxLogs = 1000
} = {}) {
  let run = {
    id: randomUUID(),
    startedAt: new Date().toISOString()
  };
  let eventItems = [];
  let logItems = [];

  return {
    recordEvent(event) {
      boundedPush(eventItems, frozenPlain(event), maxEvents);
    },

    recordLog(log) {
      boundedPush(logItems, frozenPlain(log), maxLogs);
    },

    clear() {
      eventItems = [];
      logItems = [];
    },

    events(filter) {
      return frozenPlain(eventItems.filter(event => matchesFilter(event, filter)));
    },

    logs(filter) {
      return frozenPlain(logItems.filter(log => matchesFilter(log, filter)));
    },

    requests(filter) {
      return frozenPlain(requestRecords(eventItems).filter(request => matchesFilter(request, filter)));
    },

    request(requestId) {
      return frozenPlain(requestRecords(eventItems).find(request => request.requestId === requestId));
    },

    trace(requestId) {
      let request = requestRecords(eventItems).find(item => item.requestId === requestId);

      return frozenPlain({
        requestId,
        request,
        timings: request?.timings ?? {},
        spans: spanRecords(eventItems).filter(span => span.requestId === requestId),
        logs: logItems.filter(log => log.requestId === requestId),
        events: eventItems.filter(event => event.requestId === requestId)
      });
    },

    report() {
      let endedAt = new Date().toISOString();
      let durationMs = Date.parse(endedAt) - Date.parse(run.startedAt);
      let requests = requestRecords(eventItems);
      let spans = spanRecords(eventItems);

      return frozenPlain({
        version: 1,
        run: {
          ...run,
          endedAt,
          durationMs
        },
        counts: {
          tests: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          todo: 0,
          cancelled: 0
        },
        tests: [],
        requests,
        spans,
        logs: logItems
      });
    }
  };
}
