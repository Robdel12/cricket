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

  if (typeof key !== 'string' && typeof key !== 'function')
    throw new Error(`${type} key must be a string or function`);

  if (!Number.isInteger(limit) && typeof limit !== 'function')
    throw new Error(`${type} limit must be an integer or function`);
}

/**
 * Concurrency policy builders for Cricket jobs.
 *
 * Policies are inspectable coordination metadata. Queue drivers may use them
 * while claiming work; they are not baked into the immutable envelope.
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
