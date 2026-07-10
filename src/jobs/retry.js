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
let maximumRetryDelayMs = 8_000_000_000_000_000;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
}

/**
 * Calculate the delay after one failed attempt under an exponential policy.
 *
 * Attempt one waits the base delay. Later attempts double that delay until the
 * optional maximum is reached.
 *
 * @param {object|undefined} policy
 * @param {number} attempt
 * @returns {number}
 */
export function retryDelayMs(policy, attempt) {
  if (policy?.type !== 'exponential')
    return 0;

  let delay = policy.delayMs * (2 ** Math.max(0, attempt - 1));
  return Math.min(delay, policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Calculate when a retry becomes claimable without mutating its envelope.
 *
 * @param {object|undefined} policy
 * @param {number} attempt
 * @param {Date|string} now
 * @returns {{ availableAt: string, delayMs: number }}
 */
export function retryAvailability(policy, attempt, now) {
  let delayMs = retryDelayMs(policy, attempt);
  let current = now instanceof Date ? now : new Date(now);
  let available = new Date(current.getTime() + delayMs);

  if (Number.isNaN(available.getTime()))
    throw new Error('Retry availability exceeds the supported date range');

  return {
    availableAt: available.toISOString(),
    delayMs
  };
}

/**
 * Retry policy builders for Cricket jobs.
 */
export let retry = Object.freeze({
  /**
   * Schedule failed attempts with exponential backoff.
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

    let policy = {
      type: 'exponential',
      attempts: options.attempts,
      delayMs: options.delayMs,
      ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
      ...(options.when ? { when: options.when } : {})
    };

    if (
      options.attempts > 1 &&
      retryDelayMs(policy, options.attempts - 1) > maximumRetryDelayMs
    )
      throw new Error('retry.exponential delay exceeds the supported date range');

    return frozenPlain(policy);
  }
});
