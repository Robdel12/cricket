import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let policyKeys = new Set([
  'key',
  'limit'
]);

function assertPolicy(options, type) {
  assertKnownOptions(options, policyKeys, type);

  let {
    key,
    limit
  } = options;

  if ((typeof key !== 'string' || !key) && typeof key !== 'function')
    throw new Error(`${type} key must be a non-empty string or function`);

  if ((!Number.isSafeInteger(limit) || limit < 1) && typeof limit !== 'function')
    throw new Error(`${type} limit must be a positive safe integer or function`);
}

/**
 * Concurrency policy builders for Cricket jobs.
 *
 * Policy functions resolve while Cricket plans the immutable envelope. Queue
 * drivers enforce those resolved keys and limits while claiming work.
 */
export let concurrency = Object.freeze({
  /**
   * Limit work by a computed partition key, such as an organization id.
   *
   * @param {object} options - Partition concurrency options.
   * @param {string|Function} options.key - Static key or function that computes one.
   * @param {number|Function} options.limit - Static limit or function that computes one.
   * @returns {object} Frozen concurrency policy.
   */
  partition(options = {}) {
    assertPolicy(options, 'concurrency.partition');

    return frozenPlain({
      type: 'partition',
      key: options.key,
      limit: options.limit
    });
  },

  /**
   * Limit work by a shared global key.
   *
   * @param {object} options - Global concurrency options.
   * @param {string|Function} options.key - Static key or function that computes one.
   * @param {number|Function} options.limit - Static limit or function that computes one.
   * @returns {object} Frozen concurrency policy.
   */
  global(options = {}) {
    assertPolicy(options, 'concurrency.global');

    return frozenPlain({
      type: 'global',
      key: options.key,
      limit: options.limit
    });
  }
});
