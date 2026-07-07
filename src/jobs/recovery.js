import { frozenPlain } from '../immutable.js';

let durationPattern = /^(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;

function nowMs(now) {
  return new Date(now).getTime();
}

function timeMs(value) {
  if (!value)
    return undefined;

  let parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseDuration(value) {
  if (typeof value === 'number')
    return value;

  if (typeof value !== 'string')
    throw new Error('Recovery within must be a number of milliseconds or a duration string');

  let match = value.trim().match(durationPattern);

  if (!match)
    throw new Error(`Unsupported recovery duration ${value}`);

  let amount = Number(match[1]);
  let unit = match[2].toLowerCase();

  if (unit === 'ms' || unit.startsWith('millisecond'))
    return amount;

  if (unit === 's' || unit.startsWith('sec'))
    return amount * 1_000;

  if (unit === 'm' || unit.startsWith('min'))
    return amount * 60_000;

  return amount * 60 * 60_000;
}

function matchesWhere(item, where = {}) {
  return Object.entries(where).every(([key, expected]) => item?.metadata?.[key] === expected || item?.[key] === expected);
}

function isWithin(item, {
  now,
  within
} = {}) {
  if (within === undefined)
    return true;

  let timestamp = timeMs(item?.timestamp ?? item?.time ?? item?.finishedAt);

  if (timestamp === undefined)
    return false;

  return nowMs(now) - timestamp <= parseDuration(within);
}

function newest(items) {
  return [...items].sort((left, right) =>
    (timeMs(right.timestamp ?? right.time ?? right.finishedAt) ?? 0) -
    (timeMs(left.timestamp ?? left.time ?? left.finishedAt) ?? 0)
  )[0];
}

function ageMs(value, now) {
  let timestamp = timeMs(value);

  return timestamp === undefined ? undefined : nowMs(now) - timestamp;
}

function createEventView(items, {
  now,
  key = 'event'
}) {
  function matching(name, options = {}) {
    return items.filter(item =>
      item?.[key] === name &&
      matchesWhere(item, options.where) &&
      isWithin(item, {
        now,
        within: options.within
      })
    );
  }

  return frozenPlain({
    all() {
      return frozenPlain(items);
    },

    seen(name, options) {
      return matching(name, options).length > 0;
    },

    last(name, options) {
      return frozenPlain(newest(matching(name, options)));
    },

    count(name, options) {
      return matching(name, options).length;
    }
  });
}

function createProgressView(items, {
  now
}) {
  function matching(options = {}) {
    return items.filter(item =>
      matchesWhere(item, options.where) &&
      isWithin(item, {
        now,
        within: options.within
      })
    );
  }

  return frozenPlain({
    all() {
      return frozenPlain(items);
    },

    seen(options) {
      return matching(options).length > 0;
    },

    last(options) {
      return frozenPlain(newest(matching(options)));
    },

    count(options) {
      return matching(options).length;
    }
  });
}

function reasonFor(decision = {}) {
  if (!decision.reason)
    return undefined;

  if (typeof decision.reason === 'string')
    return {
      message: decision.reason
    };

  return decision.reason;
}

export function createRecoverySnapshot({
  candidate,
  now
}) {
  let envelope = candidate.envelope;
  let run = {
    envelopeId: envelope.id,
    jobName: envelope.name,
    queueName: envelope.queueName,
    input: envelope.input,
    context: envelope.context,
    attempt: candidate.attempt,
    jobRunId: candidate.jobRunId,
    startedAt: candidate.startedAt,
    lastHeartbeatAt: candidate.lastHeartbeatAt,
    leaseActive: candidate.leaseActive === true,
    ageMs: ageMs(candidate.startedAt, now),
    heartbeatAgeMs: ageMs(candidate.lastHeartbeatAt, now)
  };

  return frozenPlain({
    run,
    ledger: frozenPlain(candidate.ledger),
    logs: createEventView(candidate.logs ?? [], {
      now,
      key: 'event'
    }),
    spans: createEventView(candidate.spans ?? [], {
      now,
      key: 'name'
    }),
    progress: createProgressView(candidate.progress ?? [], {
      now
    }),
    now
  });
}

export function normalizeRecoveryDecision(decision) {
  if (!decision)
    return frozenPlain({
      action: 'continue'
    });

  if (!['continue', 'retry', 'fail'].includes(decision.action))
    throw new Error('recover must return action continue, retry, or fail');

  return frozenPlain({
    action: decision.action,
    ...(decision.reason ? { reason: frozenPlain(reasonFor(decision)) } : {})
  });
}

export function errorFromRecoveryDecision(decision) {
  let error = new Error(decision.reason?.message ?? `Job recovery decided ${decision.action}`);

  error.name = 'JobRecoveryError';
  if (decision.reason?.code)
    error.code = decision.reason.code;

  return error;
}
