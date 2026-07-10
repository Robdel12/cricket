import { randomUUID } from 'node:crypto';

import { validationFailed } from '../errors.js';
import { frozenPlain } from '../immutable.js';
import { parseZod } from '../schema.js';
import {
  jobContextFailed,
  jobInputFailed
} from './errors.js';
import { resolveConcurrency } from './policy.js';

function callMaybeFunction(value, context) {
  return typeof value === 'function' ? value(context) : value;
}

function optionalStringMetadata(value, name) {
  if (value === undefined)
    return undefined;

  if (typeof value !== 'string' || !value)
    throw new Error(`${name} must resolve to a non-empty string`);

  return value;
}

function optionalPriority(value) {
  if (value === undefined)
    return undefined;

  if (!Number.isSafeInteger(value))
    throw new Error('Job queue priority must resolve to a safe integer');

  return value;
}

function retryPolicyFor(job) {
  if (!job.retry)
    return {
      attempts: 1
    };

  if (job.retry.type === 'exponential')
    return {
      attempts: job.retry.attempts,
      backoff: {
        type: 'exponential',
        delayMs: job.retry.delayMs,
        ...(job.retry.maxDelayMs === undefined ? {} : { maxDelayMs: job.retry.maxDelayMs })
      }
    };

  return {
    attempts: 1
  };
}

function availableAtFor({
  runAt,
  delayMs,
  createdAt
}) {
  if (runAt !== undefined && delayMs !== undefined)
    throw new Error('Job enqueue accepts runAt or delayMs, not both');

  if (delayMs !== undefined && (!Number.isInteger(delayMs) || delayMs < 0))
    throw new Error('Job enqueue delayMs must be a non-negative integer');

  if (runAt !== undefined && Number.isNaN(new Date(runAt).getTime()))
    throw new Error('Job enqueue runAt must be a Date or date string');

  if (runAt !== undefined)
    return runAt instanceof Date ? runAt.toISOString() : new Date(runAt).toISOString();

  if (delayMs !== undefined)
    return new Date(createdAt.getTime() + delayMs).toISOString();

  return createdAt.toISOString();
}

export function parseJobInput(job, input) {
  return parseZod(job.input, input, jobInputFailed);
}

export function parseJobContext(job, context) {
  return parseZod(job.context, context ?? {}, job.context ? jobContextFailed : validationFailed);
}

/**
 * Build the immutable envelope Cricket stores and queues for a job run.
 *
 * Planning validates input/context, computes queue metadata, captures retry
 * policy, and freezes the resulting plain object. Attempts, leases, progress,
 * and terminal status intentionally live outside the envelope.
 *
 * @param {object} job - Job returned by `defineJob`.
 * @param {object} input - Raw input to validate with the job input schema.
 * @param {object} [options]
 * @param {object} [options.context] - Raw enqueue context to validate.
 * @param {Date|string} [options.runAt] - Time when the envelope becomes claimable.
 * @param {number} [options.delayMs] - Relative delay before the envelope becomes claimable.
 * @param {string} [options.scheduleKey] - Schedule key that materialized this envelope.
 * @param {string} [options.scheduledFor] - Due slot timestamp for scheduled work.
 * @param {string} [options.trigger] - Materialization trigger, such as `cron` or `startup`.
 * @param {Function} [options.now] - Clock injection for deterministic tests.
 * @param {Function} [options.createId] - Envelope id factory.
 * @returns {object} Frozen job envelope.
 */
export function planJobEnvelope(job, input, {
  context,
  runAt,
  delayMs,
  scheduleKey,
  scheduledFor,
  trigger,
  now = () => new Date(),
  createId = () => `jobenv_${randomUUID()}`
} = {}) {
  if (!job.queue)
    throw new Error(`Job ${job.name} needs a queue before it can be planned`);

  let parsedInput = parseJobInput(job, input);
  let parsedContext = parseJobContext(job, context);
  let calculationContext = {
    input: parsedInput,
    context: parsedContext
  };
  let createdAt = now();
  let createdAtDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
  let createdAtText = createdAtDate.toISOString();
  let availableAt = availableAtFor({
    runAt,
    delayMs,
    createdAt: createdAtDate
  });
  let idempotencyKey = optionalStringMetadata(
    callMaybeFunction(job.queue.idempotencyKey, calculationContext),
    'Job queue idempotencyKey'
  );
  let priority = optionalPriority(
    callMaybeFunction(job.queue.priority, calculationContext)
  );
  let concurrency = resolveConcurrency(job, calculationContext);

  return frozenPlain({
    schemaVersion: 2,
    id: createId(),
    name: job.name,
    queueName: job.queue.name,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(concurrency.length ? { concurrency } : {}),
    input: parsedInput,
    context: parsedContext,
    policy: retryPolicyFor(job),
    ...(scheduleKey ? { scheduleKey } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(trigger ? { trigger } : {}),
    availableAt,
    createdAt: createdAtText
  });
}
