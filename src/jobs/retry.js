import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let exponentialKeys = new Set([
  'attempts',
  'delayMs',
  'maxDelayMs',
  'when'
]);

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
}

/**
 * Retry policy builders for Cricket jobs.
 */
export let retry = Object.freeze({
  /**
   * Retry failures with exponential backoff metadata.
   *
   * @param {object} options - Exponential retry options.
   * @param {number} options.attempts - Maximum attempts including the first run.
   * @param {number} options.delayMs - Base delay in milliseconds.
   * @param {number} [options.maxDelayMs] - Maximum delay in milliseconds.
   * @param {Function} [options.when] - Predicate that can decline retrying.
   * @returns {object} Frozen retry policy.
   */
  exponential(options = {}) {
    assertKnownOptions(options, exponentialKeys, 'retry.exponential');
    assertPositiveInteger(options.attempts, 'retry.exponential attempts');
    assertPositiveInteger(options.delayMs, 'retry.exponential delayMs');

    if (options.maxDelayMs !== undefined)
      assertPositiveInteger(options.maxDelayMs, 'retry.exponential maxDelayMs');

    if (options.when !== undefined && typeof options.when !== 'function')
      throw new Error('retry.exponential when must be a function');

    return frozenPlain({
      type: 'exponential',
      attempts: options.attempts,
      delayMs: options.delayMs,
      ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
      ...(options.when ? { when: options.when } : {})
    });
  }
});
