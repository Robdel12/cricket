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
 * @guide jobs Run background jobs
 *
 * Some work shouldn't happen during a request, like sending email or rendering a report. Jobs move it to a worker, and they keep the same contracts as your routes: validated input, your services, logs, and traces.
 *
 * Use Redis to share a queue across processes. Use a local queue for one process and the test driver when testing job behavior.
 *
 * ## Define a job
 *
 * Put jobs in a `*.jobs.js` file in the domain.
 *
 * ```js
 * import { z } from '@robdel12/cricket';
 * import { defineJob, redisQueue, retry } from '@robdel12/cricket/jobs';
 *
 * export let generateReport = defineJob({
 *   name: 'reports.generate',
 *   input: z.object({ reportId: z.string(), accountId: z.string() }),
 *   queue: redisQueue({
 *     name: 'reports',
 *     idempotencyKey: ({ input }) => input.reportId
 *   }),
 *   retry: retry.exponential({ attempts: 3, delayMs: 2_000, maxDelayMs: 60_000 }),
 *   async run({ input, services, logger, trace }) {
 *     logger.info('report.started', { reportId: input.reportId });
 *     return trace.span('reports.render', () => services.reports.generate(input));
 *   }
 * });
 * ```
 *
 * The idempotency key means asking for the same report twice while one is still running gives you the existing job instead of a duplicate.
 *
 * ## Enqueue work
 *
 * Create a producer in `setup` and pass it to your services as a dependency.
 *
 * ```js
 * import { createCricketJobs } from '@robdel12/cricket/jobs';
 *
 * let producer = await createCricketJobs({
 *   jobs: [generateReport],
 *   queues: { redis: { url: process.env.REDIS_URL } }
 * });
 *
 * await producer.jobs.enqueue(generateReport, { reportId, accountId });
 * ```
 *
 * Pass `runAt` or `delayMs` as a third argument to run it later.
 *
 * ## Start a worker
 *
 * Workers live in `api/workers/`.
 *
 * ```js
 * import { startCricketWorker } from '@robdel12/cricket/jobs';
 * import { app } from '../index.js';
 *
 * let worker = await startCricketWorker(app, {
 *   queues: { redis: { url: process.env.REDIS_URL } }
 * });
 *
 * let shutdown = new AbortController();
 * process.once('SIGTERM', () => shutdown.abort());
 *
 * try {
 *   await worker.run({ signal: shutdown.signal, concurrency: 4 });
 * } finally {
 *   await worker.cleanup();
 * }
 * ```
 *
 * The worker waits on Redis instead of polling, so it picks up new work right away. When you abort, it stops claiming jobs and lets the running ones finish.
 *
 * ## Run jobs in one process
 *
 * Give the job a `localQueue`, start the worker with `queues: { local: true }`, and enqueue through `worker.jobs`. Delays and cron run in memory.
 *
 * If you build a producer separately in the same process, pass the same `createLocalQueueDriver()` instance as `queues.driver` to both. Each runtime with `queues.local: true` gets its own queue.
 *
 * <!-- example examples/local-queue.js -->
 *
 * The queue disappears when the process stops. Keep durable work in app tables and re-enqueue any pending work at startup. A `coalesceKey` replaces pending work with the same job and key. Cancel it with `jobs.cancelPending(job, key)`. Coalescing jobs reject Cricket retry policies. Keep their retry state in app tables.
 *
 * ## Retries, limits, and failures
 *
 * - **Retries.** `retry.exponential` waits `delayMs`, doubles it each time, and stops at `maxDelayMs`.
 * - **Concurrency.** `concurrency.global` caps work across every worker. `concurrency.partition` keeps one account from hogging the queue.
 * - **Failures.** `jobFailure({ exhausted })` runs when the last retry fails, so you can mark a record as failed.
 * - **Priority.** Set `priority` on the queue. Higher numbers get claimed first.
 *
 * ## Recurring work
 *
 * Add a `schedule` to run a job on a cron:
 *
 * ```js
 * schedule: cronSchedule({
 *   key: 'daily-reports',
 *   cron: '15 4 * * *',
 *   timezone: 'America/Chicago',
 *   input: ({ scheduledFor }) => ({ reportId: `daily:${scheduledFor.slice(0, 10)}`, accountId: 'system' })
 * })
 * ```
 *
 * No separate cron server needed. The worker runs due slots itself.
 *
 * ## Stuck jobs
 *
 * Cricket keeps a heartbeat on running jobs, but it doesn't guess what "stuck" means for your work. Give the job a `recover` function that looks at the facts and decides:
 *
 * ```js
 * recover({ run, progress }) {
 *   if (run.heartbeatAgeMs > 2 * 60_000)
 *     return { action: 'retry', reason: { code: 'heartbeat_stale' } };
 *
 *   if (run.ageMs > 10 * 60_000 && !progress.seen({ within: '10 minutes' }))
 *     return { action: 'retry', reason: { code: 'not_advancing' } };
 *
 *   return { action: 'continue' };
 * }
 * ```
 *
 * Call `progress.update({ current, total })` from `run` so recovery has something to go on.
 *
 * ## Keep a history
 *
 * Want a table of past runs for debugging? Add the job ledger in a migration:
 *
 * ```js
 * import { createJobLedgerTable } from '@robdel12/cricket/jobs';
 *
 * export async function up(db) {
 *   await createJobLedgerTable(db);
 * }
 * ```
 *
 * It's execution history, not product state, so keep your real data in your own tables. You decide how long to keep history. Clean it up with `jobs.removeFinished(ids)`.
 */
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
 * @param {object} [options.queue] - Queue contract from `localQueue(...)` or `redisQueue(...)`.
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

  if (queue?.coalesceKey !== undefined && retry)
    throw new Error('Jobs with a coalescing local queue must keep retries in app state');

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
