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
  'recover',
  'concurrency',
  'state',
  'schedule',
  'run'
]);
let concurrencyPolicyKeys = new Set([
  'type',
  'key',
  'limit'
]);

function assertSchema(schema, name) {
  if (!isZodSchema(schema))
    throw new Error(`${name} must be a Zod schema`);
}

function normalizeConcurrency(value) {
  if (value === undefined)
    return [];

  let policies = Array.isArray(value) ? value : [value];
  let partitionPolicies = 0;

  for (let policy of policies) {
    if (!policy || typeof policy !== 'object')
      throw new Error('defineJob concurrency must use a Cricket concurrency policy');

    assertKnownOptions(policy, concurrencyPolicyKeys, 'defineJob concurrency');

    if (policy.type !== 'global' && policy.type !== 'partition')
      throw new Error(`defineJob concurrency received unsupported type ${policy.type}`);

    if (policy.type === 'partition')
      partitionPolicies += 1;

    if ((typeof policy.key !== 'string' || !policy.key) && typeof policy.key !== 'function')
      throw new Error(`${policy.type} concurrency key must be a non-empty string or function`);

    if ((!Number.isSafeInteger(policy.limit) || policy.limit < 1) && typeof policy.limit !== 'function')
      throw new Error(`${policy.type} concurrency limit must be a positive safe integer or function`);
  }

  if (partitionPolicies > 1)
    throw new Error('defineJob accepts one partition concurrency policy');

  return policies;
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

  if (schedule.runOnStartup !== undefined && typeof schedule.runOnStartup !== 'boolean')
    throw new Error('schedule runOnStartup must be a boolean');
}

function assertFailure(failure) {
  if (failure !== undefined && !isJobFailureContract(failure))
    throw new Error('defineJob failure must be a jobFailure contract');
}

function assertRecover(recover) {
  if (recover !== undefined && typeof recover !== 'function')
    throw new Error('defineJob recover must be a function');
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
 * @param {Function} [options.recover] - Pure recovery decision over job logs, spans, progress, ledger, and run state.
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
    recover,
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
  assertRecover(recover);

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

  if (recover)
    job.recover = recover;

  if (state)
    job.state = state;

  if (schedule)
    job.schedule = frozenPlain(schedule);

  return frozenPlain(job);
}
