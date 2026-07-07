import { randomUUID } from 'node:crypto';

import { frozenPlain } from '../immutable.js';

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

function jobFromEvent(event) {
  return {
    jobName: event.jobName,
    jobRunId: event.jobRunId,
    envelopeId: event.envelopeId,
    queueName: event.queueName,
    scheduleKey: event.scheduleKey,
    scheduledFor: event.scheduledFor,
    availableAt: event.availableAt,
    trigger: event.trigger,
    requestId: event.requestId,
    type: event.type,
    attempt: event.attempt,
    decision: event.decision,
    error: event.error,
    progress: event.progress
  };
}

function jobRecords(eventItems) {
  return eventItems
    .filter(event => typeof event.type === 'string' && event.type.startsWith('job.'))
    .map(jobFromEvent);
}

/**
 * Create an in-memory Cricket test collector.
 *
 * The collector stores safe runtime facts emitted by Cricket's HTTP lifecycle:
 * request events, structured logs, trace spans, and terminal request timings.
 *
 * @param {object} [options]
 * @param {number} [options.maxEvents=1000] - Maximum lifecycle events retained.
 * @param {number} [options.maxLogs=1000] - Maximum structured logs retained.
 * @returns {object} Test state inspection API, including request and job views.
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

    jobs(filter) {
      return frozenPlain(jobRecords(eventItems).filter(job => matchesFilter(job, filter)));
    },

    job(jobRunId) {
      let events = eventItems.filter(event => event.jobRunId === jobRunId);

      return frozenPlain({
        jobRunId,
        events,
        spans: spanRecords(eventItems).filter(span => span.context?.jobRunId === jobRunId),
        logs: logItems.filter(log => log.metadata?.jobRunId === jobRunId)
      });
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
      let jobs = jobRecords(eventItems);
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
        jobs,
        spans,
        logs: logItems
      });
    }
  };
}
