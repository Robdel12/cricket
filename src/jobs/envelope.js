import { randomUUID } from 'node:crypto';

import { validationFailed } from '../errors.js';
import { frozenPlain } from '../immutable.js';
import { parseZod } from '../schema.js';
import {
  jobContextFailed,
  jobInputFailed
} from './errors.js';

function callMaybeFunction(value, context) {
  return typeof value === 'function' ? value(context) : value;
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
 * @param {Function} [options.now] - Clock injection for deterministic tests.
 * @param {Function} [options.createId] - Envelope id factory.
 * @returns {object} Frozen job envelope.
 */
export function planJobEnvelope(job, input, {
  context,
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
  let createdAtText = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);

  return frozenPlain({
    schemaVersion: 1,
    id: createId(),
    name: job.name,
    queueName: job.queue.name,
    ...(job.queue.idempotencyKey ? {
      idempotencyKey: callMaybeFunction(job.queue.idempotencyKey, calculationContext)
    } : {}),
    ...(job.queue.partition ? {
      partition: callMaybeFunction(job.queue.partition, calculationContext)
    } : {}),
    ...(job.queue.priority ? {
      priority: callMaybeFunction(job.queue.priority, calculationContext)
    } : {}),
    input: parsedInput,
    context: parsedContext,
    policy: retryPolicyFor(job),
    createdAt: createdAtText
  });
}
