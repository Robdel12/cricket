import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';

let jobFailureKeys = new Set([
  'retrying',
  'exhausted'
]);

function assertHandler(handler, name) {
  if (handler !== undefined && typeof handler !== 'function')
    throw new Error(`jobFailure ${name} must be a function`);
}

export function isJobFailureContract(value) {
  return value &&
    typeof value === 'object' &&
    value.type === 'job.failure';
}

/**
 * Define first-class failure handlers for a Cricket job.
 *
 * Use `retrying` to sync product state after Cricket has scheduled a retry.
 * Use `exhausted` to sync product state after Cricket has marked the envelope
 * failed. Handler failures are logged and observed, but they do not replace
 * the original job failure.
 *
 * @param {object} [options] - Failure handler options.
 * @param {Function} [options.retrying] - Called after a retry is scheduled.
 * @param {Function} [options.exhausted] - Called after the job is finally failed.
 * @returns {object} Frozen failure contract.
 */
export function jobFailure(options = {}) {
  assertKnownOptions(options, jobFailureKeys, 'jobFailure');
  assertHandler(options.retrying, 'retrying');
  assertHandler(options.exhausted, 'exhausted');

  return frozenPlain({
    type: 'job.failure',
    ...(options.retrying ? { retrying: options.retrying } : {}),
    ...(options.exhausted ? { exhausted: options.exhausted } : {})
  });
}
