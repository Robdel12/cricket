import { frozenPlain } from '../immutable.js';
import {
  canClaimEnvelope,
  compareClaimOrder
} from './policy.js';

function duplicateFor(items, envelope) {
  let duplicateId = items.find(item => item.envelope.id === envelope.id);

  if (duplicateId)
    return duplicateId;

  if (!envelope.idempotencyKey)
    return undefined;

  return items.find(item =>
    item.envelope.name === envelope.name &&
    item.envelope.idempotencyKey === envelope.idempotencyKey &&
    item.status !== 'completed' &&
    item.status !== 'failed'
  );
}

function itemFor(items, envelope) {
  return items.find(candidate => candidate.envelope.id === envelope.id);
}

function ownsAttempt(item, attempt) {
  return item?.status === 'active' && item.attempts === attempt;
}

function availableNow(envelope, now) {
  return new Date(envelope.availableAt ?? envelope.createdAt) <= new Date(now ?? envelope.createdAt);
}

function itemAvailableNow(item, now) {
  return new Date(item.availableAt) <= new Date(now);
}

function timestamp(now = new Date()) {
  return now instanceof Date ? now.toISOString() : String(now);
}

/**
 * Create an in-memory queue driver for Cricket job tests.
 *
 * The test driver preserves the queue driver contract without Redis, records
 * execution events, and exposes a frozen snapshot for assertions.
 *
 * @returns {object} Queue driver implementation for tests.
 */
export function createTestQueueDriver() {
  let items = [];
  let events = [];
  let schedules = [];
  let workWaiters = new Set();

  function notifyWork(queueName) {
    for (let notify of [...workWaiters])
      notify({
        reason: 'work',
        queueName
      });
  }

  function record(type, envelope, metadata = {}) {
    events.push(frozenPlain({
      type,
      envelopeId: envelope.id,
      jobName: envelope.name,
      queueName: envelope.queueName,
      ...metadata
    }));
  }

  return {
    async enqueue(envelope) {
      let duplicate = duplicateFor(items, envelope);

      if (duplicate)
        return frozenPlain({
          enqueued: false,
          duplicate: true,
          envelope: duplicate.envelope
        });

      items.push({
        envelope,
        status: availableNow(envelope) ? 'queued' : 'delayed',
        availableAt: envelope.availableAt,
        attempts: 0,
        logs: [],
        progress: [],
        spans: []
      });
      record('queued', envelope);

      notifyWork(envelope.queueName);

      return frozenPlain({
        enqueued: true,
        duplicate: false,
        envelope
      });
    },

    async claim() {
      let activeEnvelopes = items
        .filter(candidate => candidate.status === 'active')
        .map(candidate => candidate.envelope);
      let item = items
        .filter(candidate => candidate.status === 'queued')
        .sort((left, right) => compareClaimOrder(left.envelope, right.envelope))
        .find(candidate => canClaimEnvelope(candidate.envelope, activeEnvelopes));

      if (!item)
        return undefined;

      item.status = 'active';
      item.attempts += 1;
      item.startedAt = timestamp();
      item.lastHeartbeatAt = timestamp();
      item.logs = [];
      item.progress = [];
      item.spans = [];
      record('claimed', item.envelope, {
        attempt: item.attempts
      });

      return frozenPlain({
        envelope: item.envelope,
        attempt: item.attempts
      });
    },

    async progress(envelope, progress, {
      attempt
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          recorded: false
        });

      item.progress.push({
        progress,
        timestamp: timestamp()
      });

      record('progressed', envelope, {
        progress
      });
      return frozenPlain({
        recorded: true
      });
    },

    async complete(envelope, result, {
      attempt
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          settled: false
        });

      item.status = 'completed';
      item.result = result;
      item.finishedAt = timestamp();

      record('completed', envelope);
      return frozenPlain({
        settled: true
      });
    },

    async fail(envelope, error, {
      attempt
    } = {}) {
      let item = itemFor(items, envelope);
      let failure = {
        name: error?.name,
        message: error?.message
      };

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          settled: false
        });

      item.status = 'failed';
      item.error = failure;
      item.finishedAt = timestamp();

      record('failed', envelope, {
        error: failure
      });
      return frozenPlain({
        settled: true
      });
    },

    async retry(envelope, {
      attempt,
      availableAt,
      now = new Date()
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          settled: false
        });

      item.availableAt = availableAt ?? timestamp(now);
      item.status = itemAvailableNow(item, now) ? 'queued' : 'delayed';
      item.startedAt = undefined;

      record('retry_scheduled', envelope, {
        availableAt: item.availableAt
      });

      notifyWork(envelope.queueName);

      return frozenPlain({
        settled: true
      });
    },

    async heartbeat(envelope, {
      attempt,
      now = new Date()
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          renewed: false
        });

      item.lastHeartbeatAt = timestamp(now);
      return frozenPlain({
        renewed: true
      });
    },

    async recordLog(envelope, log, {
      attempt
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          recorded: false
        });

      item.logs.push({
        ...log,
        timestamp: log.timestamp ?? timestamp()
      });
      return frozenPlain({
        recorded: true
      });
    },

    async recordSpan(envelope, span, {
      attempt
    } = {}) {
      let item = itemFor(items, envelope);

      if (!ownsAttempt(item, attempt))
        return frozenPlain({
          recorded: false
        });

      item.spans.push({
        ...span,
        timestamp: span.timestamp ?? timestamp()
      });
      return frozenPlain({
        recorded: true
      });
    },

    async recoveryCandidates() {
      return frozenPlain(items
        .filter(item => item.status === 'active')
        .map(item => ({
          envelope: item.envelope,
          attempt: item.attempts,
          startedAt: item.startedAt,
          lastHeartbeatAt: item.lastHeartbeatAt,
          leaseActive: true,
          logs: item.logs,
          spans: item.spans,
          progress: item.progress,
          ledger: {
            status: item.status,
            attempts: item.attempts,
            startedAt: item.startedAt,
            updatedAt: item.lastHeartbeatAt
          }
        })));
    },

    async promoteDelayed({
      now = new Date()
    } = {}) {
      let promoted = [];

      for (let item of items) {
        if (item.status !== 'delayed' || !itemAvailableNow(item, now))
          continue;

        item.status = 'queued';
        promoted.push(item.envelope);
        record('delay_promoted', item.envelope);
        notifyWork(item.envelope.queueName);
      }

      return frozenPlain(promoted);
    },

    async nextAvailableAt() {
      let delayed = items
        .filter(item => item.status === 'delayed')
        .map(item => item.availableAt)
        .sort();

      return delayed[0];
    },

    async waitForWork({
      signal,
      until,
      waitUntil
    } = {}) {
      let queued = items.find(item => item.status === 'queued');

      if (queued)
        return frozenPlain({
          reason: 'work',
          queueName: queued.envelope.queueName
        });

      if (signal?.aborted)
        return frozenPlain({
          reason: 'aborted'
        });

      return await new Promise((resolve, reject) => {
        let settled = false;
        let deadline = new AbortController();
        let deadlineSignal = signal
          ? AbortSignal.any([signal, deadline.signal])
          : deadline.signal;
        let onAbort = () => settle({
          reason: 'aborted'
        });
        let onWork = settle;

        function settle(result) {
          if (settled)
            return;

          settled = true;
          workWaiters.delete(onWork);
          signal?.removeEventListener('abort', onAbort);
          deadline.abort();
          resolve(frozenPlain(result));
        }

        workWaiters.add(onWork);
        signal?.addEventListener('abort', onAbort, {
          once: true
        });

        if (until) {
          Promise.resolve(waitUntil(until, {
            signal: deadlineSignal
          })).then(() => settle({
            reason: 'deadline'
          })).catch(error => {
            if (error?.name === 'AbortError')
              return;

            if (!settled) {
              settled = true;
              workWaiters.delete(onWork);
              signal?.removeEventListener('abort', onAbort);
              reject(error);
            }
          });
        }
      });
    },

    async registerSchedule(job, {
      enabled,
      lastRunAt,
      nextRunAt
    } = {}) {
      let existing = schedules.find(schedule => schedule.key === job.schedule.key);
      let nextSchedule = {
        key: job.schedule.key,
        jobName: job.name,
        cron: job.schedule.cron,
        timezone: job.schedule.timezone,
        enabled,
        lastRunAt,
        nextRunAt
      };

      if (existing)
        Object.assign(existing, nextSchedule);
      else
        schedules.push(nextSchedule);
    },

    async scheduleState(job) {
      let schedule = schedules.find(candidate => candidate.key === job.schedule.key);
      return schedule ? frozenPlain(schedule) : undefined;
    },

    async updateSchedule(job, values = {}) {
      let schedule = schedules.find(candidate => candidate.key === job.schedule.key);

      if (schedule)
        Object.assign(schedule, values);
    },

    async materializeSchedule(envelope, {
      slotId
    }) {
      let duplicate = items.find(item => item.slotId === slotId);

      if (duplicate)
        return frozenPlain({
          enqueued: false,
          duplicate: true,
          envelope: duplicate.envelope
        });

      let result = await this.enqueue(envelope);
      let item = itemFor(items, result.envelope);

      if (item)
        item.slotId = slotId;

      return result;
    },

    async removeFinished(ids) {
      let removed = [];
      let missing = [];
      let skipped = [];

      for (let id of ids) {
        let index = items.findIndex(item => item.envelope.id === id);

        if (index === -1) {
          missing.push(id);
          continue;
        }

        let item = items[index];

        if (item.status !== 'completed' && item.status !== 'failed') {
          skipped.push({
            id,
            reason: 'not_finished'
          });
          continue;
        }

        items.splice(index, 1);
        events = events.filter(event => event.envelopeId !== id);
        removed.push(id);
      }

      return frozenPlain({
        removed,
        missing,
        skipped
      });
    },

    snapshot() {
      return frozenPlain({
        items,
        events,
        schedules
      });
    },

    async cleanup() {
      for (let notify of [...workWaiters])
        notify({
          reason: 'aborted'
        });
    }
  };
}
