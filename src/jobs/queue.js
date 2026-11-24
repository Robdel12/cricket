import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let redisQueueKeys = new Set([
  'name',
  'idempotencyKey',
  'priority'
]);

/**
 * Describe the Redis queue a job should use.
 *
 * The queue contract is pure metadata. Job code never receives Redis or driver
 * objects; Cricket uses this contract when planning and enqueueing envelopes.
 *
 * @param {object} options - Redis queue options.
 * @param {string} options.name - Queue name.
 * @param {Function} [options.idempotencyKey] - Prevents another unfinished run with the same key.
 * @param {Function} [options.priority] - Computes numeric claim priority; higher values run first.
 * @returns {object} Frozen Redis queue contract.
 */
export function redisQueue(options = {}) {
  assertKnownOptions(options, redisQueueKeys, 'redisQueue');

  return queueContract('redis', options);
}

function queueContract(type, options, coalesceKey) {
  let builder = `${type}Queue`;
  if (!options.name || typeof options.name !== 'string')
    throw new Error(`${builder} needs a string name`);

  if (options.idempotencyKey !== undefined && typeof options.idempotencyKey !== 'function')
    throw new Error(`${builder} idempotencyKey must be a function`);

  if (options.priority !== undefined && typeof options.priority !== 'function')
    throw new Error(`${builder} priority must be a function`);

  let queue = {
    type,
    name: options.name
  };

  if (options.idempotencyKey)
    queue.idempotencyKey = options.idempotencyKey;

  if (options.priority)
    queue.priority = options.priority;

  if (coalesceKey !== undefined)
    queue.coalesceKey = coalesceKey;

  return frozenPlain(queue);
}


let localQueueKeys = new Set([...redisQueueKeys, 'coalesceKey']);

/**
 * Describe a queue for work that runs inside one process. Pending and active
 * envelopes live in memory. Rebuild wakeups from app-owned durable state on startup
 * when work must survive a restart.
 * @param {object} options - Local queue options.
 * @param {string} options.name - Queue name.
 * @param {Function} [options.idempotencyKey] - Deduplicate unfinished work.
 * @param {Function} [options.priority] - Compute numeric claim priority.
 * @param {string|Function} [options.coalesceKey] - Replace pending work with the same job and key. It waits for an active run with that key to finish.
 * @returns {object} Frozen local queue contract.
 */
export function localQueue(options = {}) {
  assertKnownOptions(options, localQueueKeys, 'localQueue');
  let { coalesceKey, ...shared } = options;

  if (coalesceKey !== undefined &&
      typeof coalesceKey !== 'function' &&
      (typeof coalesceKey !== 'string' || !coalesceKey))
    throw new Error('localQueue coalesceKey must be a non-empty string or function');

  if (coalesceKey !== undefined && shared.idempotencyKey !== undefined)
    throw new Error('localQueue accepts either coalesceKey or idempotencyKey');

  return queueContract('local', shared, coalesceKey);
}
