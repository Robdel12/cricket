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
 * @param {Function} [options.idempotencyKey] - Prevents another non-terminal run with the same key.
 * @param {Function} [options.priority] - Computes numeric claim priority; higher values run first.
 * @returns {object} Frozen Redis queue contract.
 */
export function redisQueue(options = {}) {
  assertKnownOptions(options, redisQueueKeys, 'redisQueue');

  if (!options.name || typeof options.name !== 'string')
    throw new Error('redisQueue needs a string name');

  if (options.idempotencyKey !== undefined && typeof options.idempotencyKey !== 'function')
    throw new Error('redisQueue idempotencyKey must be a function');

  if (options.priority !== undefined && typeof options.priority !== 'function')
    throw new Error('redisQueue priority must be a function');

  let queue = {
    type: 'redis',
    name: options.name
  };

  if (options.idempotencyKey)
    queue.idempotencyKey = options.idempotencyKey;

  if (options.priority)
    queue.priority = options.priority;

  return frozenPlain(queue);
}
