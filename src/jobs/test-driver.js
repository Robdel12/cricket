import { frozenPlain } from '../immutable.js';

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

function availableNow(envelope, now) {
  return new Date(envelope.availableAt ?? envelope.createdAt) <= new Date(now ?? envelope.createdAt);
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
        attempts: 0,
        progress: []
      });
      record('queued', envelope);

      return frozenPlain({
        enqueued: true,
        duplicate: false,
        envelope
      });
    },

    async claim() {
      let item = items.find(candidate => candidate.status === 'queued');

      if (!item)
        return undefined;

      item.status = 'active';
      item.attempts += 1;
      record('claimed', item.envelope, {
        attempt: item.attempts
      });

      return frozenPlain({
        envelope: item.envelope,
        attempt: item.attempts
      });
    },

    async progress(envelope, progress) {
      let item = itemFor(items, envelope);

      if (item)
        item.progress.push(progress);

      record('progressed', envelope, {
        progress
      });
    },

    async complete(envelope, result) {
      let item = itemFor(items, envelope);

      if (item) {
        item.status = 'completed';
        item.result = result;
      }

      record('completed', envelope);
    },

    async fail(envelope, error) {
      let item = itemFor(items, envelope);
      let failure = {
        name: error?.name,
        message: error?.message
      };

      if (item) {
        item.status = 'failed';
        item.error = failure;
      }

      record('failed', envelope, {
        error: failure
      });
    },

    async retry(envelope) {
      let item = itemFor(items, envelope);

      if (item)
        item.status = 'queued';

      record('retry_scheduled', envelope);
    },

    async promoteDelayed({
      now = new Date()
    } = {}) {
      let promoted = [];

      for (let item of items) {
        if (item.status !== 'delayed' || !availableNow(item.envelope, now))
          continue;

        item.status = 'queued';
        promoted.push(item.envelope);
        record('delay_promoted', item.envelope);
      }

      return frozenPlain(promoted);
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

    snapshot() {
      return frozenPlain({
        items,
        events,
        schedules
      });
    },

    async cleanup() {}
  };
}
