import {
  frozenPlain
} from '../immutable.js';
import { assertKnownOptions } from '../options.js';
import { isZodSchema } from '../schema.js';
import { isJobFailureContract } from './failure.js';

let jobOptionKeys = new Set([
  'name',
  'input',
  'context',
  'result',
  'queue',
  'retry',
  'failure',
  'concurrency',
  'state',
  'schedule',
  'run'
]);

function assertSchema(schema, name) {
  if (!isZodSchema(schema))
    throw new Error(`${name} must be a Zod schema`);
}

function normalizeConcurrency(value) {
  if (value === undefined)
    return [];

  return Array.isArray(value) ? value : [value];
}

function assertSchedule(schedule) {
  if (schedule === undefined)
    return;

  if (!schedule || typeof schedule !== 'object')
    throw new Error('schedule must be an object');

  if (!schedule.key || typeof schedule.key !== 'string')
    throw new Error('schedule needs a key');

  if (!schedule.cron || typeof schedule.cron !== 'string')
    throw new Error('schedule needs a cron');

  if (schedule.timezone !== undefined && typeof schedule.timezone !== 'string')
    throw new Error('schedule timezone must be a string');

  if (typeof schedule.input !== 'function')
    throw new Error('schedule input must be a function');

  if (schedule.enabled !== undefined && typeof schedule.enabled !== 'function')
    throw new Error('schedule enabled must be a function');

  if (schedule.removeWhenDisabled !== undefined && typeof schedule.removeWhenDisabled !== 'boolean')
    throw new Error('schedule removeWhenDisabled must be a boolean');

  if (schedule.runOnStartup !== undefined && typeof schedule.runOnStartup !== 'boolean')
    throw new Error('schedule runOnStartup must be a boolean');
}

function assertFailure(failure) {
  if (failure !== undefined && !isJobFailureContract(failure))
    throw new Error('defineJob failure must be a jobFailure contract');
}

export function isJobContract(value) {
  return value &&
    typeof value === 'object' &&
    value.kind === 'cricket.job' &&
    typeof value.name === 'string' &&
    typeof value.run === 'function';
}

/**
 * Define a Cricket background job contract.
 *
 * The returned job is frozen plain data plus a `run` function. Cricket uses it
 * to validate enqueue input, plan immutable envelopes, inspect app topology,
 * and execute work with services/logger/trace/lifecycle capabilities.
 *
 * @param {object} options - Job contract options.
 * @param {string} options.name - Stable namespaced job name.
 * @param {object} options.input - Zod schema for the immutable job input.
 * @param {object} [options.context] - Zod schema for enqueue metadata.
 * @param {object} [options.result] - Zod schema for the job result.
 * @param {object} [options.queue] - Queue contract, usually `redisQueue(...)`.
 * @param {object} [options.retry] - Retry policy, usually `retry.exponential(...)`.
 * @param {object} [options.failure] - Failure handlers, usually `jobFailure(...)`.
 * @param {object|object[]} [options.concurrency] - Concurrency policy or policies.
 * @param {object} [options.state] - Inspect metadata for where product truth lives.
 * @param {object} [options.schedule] - Schedule metadata that produces normal envelopes.
 * @param {Function} options.run - Async function that performs the work.
 * @returns {object} Frozen Cricket job contract.
 */
export function defineJob(options = {}) {
  assertKnownOptions(options, jobOptionKeys, 'defineJob');

  let {
    name,
    input,
    context,
    result,
    queue,
    retry,
    failure,
    concurrency,
    state,
    schedule,
    run
  } = options;

  if (!name || typeof name !== 'string')
    throw new Error('defineJob needs a string name');

  assertSchema(input, 'defineJob input');

  if (context !== undefined)
    assertSchema(context, 'defineJob context');

  if (result !== undefined)
    assertSchema(result, 'defineJob result');

  if (typeof run !== 'function')
    throw new Error('defineJob run must be a function');

  assertSchedule(schedule);
  assertFailure(failure);

  let job = {
    kind: 'cricket.job',
    name,
    input,
    concurrency: normalizeConcurrency(concurrency),
    run
  };

  if (context)
    job.context = context;

  if (result)
    job.result = result;

  if (queue)
    job.queue = queue;

  if (retry)
    job.retry = retry;

  if (failure)
    job.failure = failure;

  if (state)
    job.state = state;

  if (schedule)
    job.schedule = frozenPlain(schedule);

  return frozenPlain(job);
}
