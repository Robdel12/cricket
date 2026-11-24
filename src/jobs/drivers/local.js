import { EventEmitter, once } from 'node:events';

import { frozenPlain } from '../../immutable.js';
import { canClaimEnvelope, compareClaimOrder } from '../policy.js';

function matchesKey(left, right, key) {
  return left.name === right.name &&
    left.queueName === right.queueName &&
    left[key] === right[key];
}

/**
 * Create a process-local Cricket queue. Share the same driver instance between
 * a producer and a worker, or let a worker create its own with `queues.local`.
 * Work and cron positions are cleared at cleanup and lost on process exit.
 * @param {object} [options]
 * @param {Function} [options.now] - Clock used to decide which work is ready.
 * @returns {object} Local queue driver.
 */
export function createLocalQueueDriver({ now = () => new Date() } = {}) {
  let items = new Map();
  let schedules = new Map();
  let slots = new Map();
  let wake = new EventEmitter();
  let closed = false;

  function notify(reason = 'work') {
    wake.emit('change', { reason });
  }

  function eligible() {
    let active = [...items.values()].filter(item => item.active).map(item => item.envelope);
    return [...items.values()].filter(({ envelope, active: claimed }) =>
      !claimed &&
      canClaimEnvelope(envelope, active) &&
      !(envelope.coalesceKey && active.some(run => matchesKey(run, envelope, 'coalesceKey')))
    );
  }

  function ready(candidates = eligible()) {
    let at = new Date(now()).toISOString();
    return candidates.filter(item => item.availableAt <= at)
      .sort((left, right) => compareClaimOrder(left.envelope, right.envelope))[0];
  }

  function earliest(candidates) {
    return candidates.map(item => item.availableAt).sort()[0];
  }

  function enqueue(envelope) {
    if (closed)
      throw new Error('Cricket local queue is closed');

    let duplicate = items.get(envelope.id);
    if (!duplicate && envelope.idempotencyKey)
      duplicate = [...items.values()].find(item =>
        matchesKey(item.envelope, envelope, 'idempotencyKey')
      );

    if (duplicate)
      return frozenPlain({ enqueued: false, duplicate: true, envelope: duplicate.envelope });

    let replaced = cancelPending(envelope);
    items.set(envelope.id, { envelope, attempt: 0, active: false, availableAt: envelope.availableAt });
    notify();
    return frozenPlain({ enqueued: true, duplicate: false, envelope, ...(replaced ? { replaced } : {}) });
  }

  function cancelPending(target) {
    if (!target.coalesceKey)
      return undefined;

    let pending = [...items.values()].find(item =>
      !item.active && matchesKey(item.envelope, target, 'coalesceKey')
    );
    if (!pending)
      return undefined;

    items.delete(pending.envelope.id);
    notify();
    return pending.envelope;
  }

  function ownsAttempt(envelope, attempt) {
    let item = items.get(envelope.id);
    return item?.active && item.attempt === attempt ? item : undefined;
  }

  function finish(envelope, _result, { attempt } = {}) {
    if (!ownsAttempt(envelope, attempt))
      return { settled: false };

    items.delete(envelope.id);
    notify();
    return { settled: true };
  }

  return Object.freeze({
    enqueue,
    cancelPending,
    claim() {
      let item = ready();
      if (!item)
        return undefined;

      item.active = true;
      item.attempt += 1;
      return frozenPlain({ envelope: item.envelope, attempt: item.attempt });
    },
    complete: finish,
    fail: finish,
    retry(envelope, { attempt, availableAt } = {}) {
      let item = ownsAttempt(envelope, attempt);
      if (!item)
        return { settled: false };

      item.active = false;
      item.availableAt = availableAt ?? new Date(now()).toISOString();
      notify();
      return { settled: true };
    },
    nextAvailableAt() {
      return earliest(eligible());
    },
    async waitForWork({ signal, until, waitUntil } = {}) {
      if (closed || signal?.aborted)
        return { reason: 'aborted' };

      let candidates = eligible();
      if (ready(candidates))
        return { reason: 'work' };

      let deadline = [until, earliest(candidates)].filter(Boolean).sort()[0];
      let wait = new AbortController();
      let waitSignal = signal ? AbortSignal.any([signal, wait.signal]) : wait.signal;
      try {
        let changed = once(wake, 'change', { signal: waitSignal }).then(([result]) => result);
        return await Promise.race([
          changed,
          ...(deadline ? [Promise.resolve().then(() => waitUntil(deadline, { signal: waitSignal })).then(() => ({ reason: 'deadline' }))] : [])
        ]);
      } catch (error) {
        if (!signal?.aborted || error.name !== 'AbortError')
          throw error;

        return { reason: 'aborted' };
      } finally {
        wait.abort();
      }
    },
    registerSchedule(job, values) {
      schedules.set(job.schedule.key, frozenPlain(values));
    },
    scheduleState(job) {
      return schedules.get(job.schedule.key);
    },
    updateSchedule(job, values) {
      let current = schedules.get(job.schedule.key);
      if (values.lastRunAt && current?.lastRunAt > values.lastRunAt)
        return;

      schedules.set(job.schedule.key, frozenPlain({ ...current, ...values }));
    },
    materializeSchedule(envelope) {
      let previous = slots.get(envelope.scheduleKey);
      if (previous >= envelope.scheduledFor)
        return frozenPlain({ enqueued: false, duplicate: true, envelope });

      let result = enqueue(envelope);
      slots.set(envelope.scheduleKey, envelope.scheduledFor);
      return result;
    },
    removeFinished(ids) {
      return frozenPlain({
        removed: [],
        missing: ids.filter(id => !items.has(id)),
        skipped: ids.filter(id => items.has(id)).map(id => ({ id, reason: 'not_finished' }))
      });
    },
    cleanup() {
      closed = true;
      items.clear();
      schedules.clear();
      slots.clear();
      notify('aborted');
    }
  });
}
