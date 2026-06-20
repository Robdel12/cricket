import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createCricketRuntime } from '../http/runtime.js';
import { createTrace } from '../trace.js';
import { parseZod } from '../schema.js';
import { jobResultFailed } from './errors.js';
import { planJobEnvelope } from './envelope.js';
import { createRedisQueueDriver } from './drivers/redis.js';
import { createJobLedger } from './ledger.js';
import {
  planCronSchedule,
  previousCronRun
} from './schedule.js';
import { createTestQueueDriver } from './test-driver.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function jobsByName(jobs) {
  return new Map(jobs.map(job => [job.name, job]));
}

function safeError(error) {
  return {
    ...(error?.name ? { name: error.name } : {}),
    ...(error?.message ? { message: error.message } : {})
  };
}

function createLedgerRecorder({
  ledger,
  logger
}) {
  return async function recordLedger(action, envelope, write) {
    try {
      await write(ledger);
    } catch (error) {
      logger?.warn?.('job.ledger_failed', {
        action,
        envelopeId: envelope.id,
        jobName: envelope.name,
        queueName: envelope.queueName,
        error: safeError(error)
      });
    }
  };
}

function createProgressCapability(driver, recordLedger, envelope, emitJobEvent) {
  return {
    async update(progress) {
      await driver.progress?.(envelope, progress);
      await recordLedger('progressed', envelope, ledger => ledger.progressed(envelope, {
        progress
      }));
      await emitJobEvent('job.progressed', envelope, {
        progress
      });
    }
  };
}

function shouldRetry(job, error, envelope, attempt) {
  if (!job.retry)
    return false;

  if (attempt >= job.retry.attempts)
    return false;

  if (job.retry.when)
    return job.retry.when({
      error,
      envelope,
      attempt
    }) !== false;

  return true;
}

function parseJobResult(job, result) {
  if (!job.result)
    return result;

  return parseZod(job.result, result, jobResultFailed);
}

function jobRunContext(envelope, jobRunId) {
  return {
    jobRunId,
    requestId: envelope.context?.requestId
  };
}

function failureContext({
  envelope,
  error,
  attempt,
  jobRun,
  runtime,
  logger,
  trace,
  jobsCapability,
  progress
}) {
  return {
    input: envelope.input,
    context: envelope.context,
    error,
    failure: safeError(error),
    envelope,
    attempt,
    jobRunId: jobRun.jobRunId,
    requestId: jobRun.requestId,
    services: runtime.services,
    logger,
    trace,
    lifecycle: runtime.lifecycle,
    jobs: jobsCapability,
    progress
  };
}

function timestamp(value) {
  let date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function scheduleContext(runtime, {
  now,
  scheduledFor
} = {}) {
  return {
    now,
    scheduledFor,
    env: process.env,
    services: runtime.services,
    lifecycle: runtime.lifecycle
  };
}

async function createDriver(queues = {}, jobList = []) {
  if (queues.driver)
    return queues.driver;

  if (queues.test)
    return createTestQueueDriver();

  if (queues.redis)
    return await createRedisQueueDriver({
      ...queues.redis,
      queueNames: jobList
        .map(job => job.queue?.name)
        .filter(Boolean)
    });

  return createTestQueueDriver();
}

function createJobsCapability({
  driver,
  recordLedger,
  clock
}) {
  let jobsCapability = {
    plan: planJobEnvelope,

    async enqueue(job, input, options = {}) {
      let envelope = planJobEnvelope(job, input, {
        ...options,
        now: options.now ?? clock.now
      });
      let result = await driver.enqueue(envelope);

      if (result.enqueued)
        await recordLedger('queued', envelope, ledger => ledger.queued(envelope));

      return result;
    },

    async enqueueMany(job, inputs, options = {}) {
      let results = [];

      for (let input of inputs)
        results.push(await jobsCapability.enqueue(job, input, options));

      return results;
    }
  };

  return jobsCapability;
}

/**
 * Create a producer-side Cricket jobs capability.
 *
 * Use this in app runtimes that need to enqueue job envelopes without starting
 * a worker loop. It shares the same queue driver and optional ledger behavior
 * as `startCricketWorker`.
 *
 * @param {object} [options]
 * @param {object} [options.clock] - Clock used for deterministic enqueue and schedule tests.
 * @param {object[]} [options.jobs] - Job contracts used to initialize queue names.
 * @param {object} [options.ledger] - Job ledger options.
 * @param {object} [options.ledger.db] - Knex database handle for ledger writes.
 * @param {string} [options.ledger.tableName='cricket_jobs'] - Ledger table name.
 * @param {object} [options.logger] - Logger used for best-effort ledger warnings.
 * @param {object} [options.queues] - Queue driver configuration.
 * @returns {Promise<object>} Producer controls, driver, ledger, and jobs capability.
 */
export async function createCricketJobs({
  clock = {
    now: () => new Date()
  },
  jobs = [],
  ledger: ledgerOptions = {},
  logger,
  queues = {}
} = {}) {
  let jobList = toArray(jobs);
  let driver = await createDriver(queues, jobList);
  let ledger = createJobLedger(ledgerOptions);
  let recordLedger = createLedgerRecorder({
    ledger,
    logger
  });
  let jobsCapability = createJobsCapability({
    driver,
    recordLedger,
    clock
  });

  return {
    driver,
    ledger,
    jobs: jobsCapability,
    cleanup: async () => {
      await driver.cleanup?.();
    }
  };
}

/**
 * Start a Cricket worker runtime for registered jobs.
 *
 * The worker reuses Cricket app assembly, so job `run` functions receive the
 * same services, logger, trace, lifecycle, and cleanup behavior as HTTP
 * handlers. Queue drivers remain at the runtime boundary.
 *
 * @param {object} cricketApp - App returned by `defineCricketApp`.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - Module URL used to resolve domain paths.
 * @param {object} [options.clock] - Clock used for deterministic enqueue and schedule tests.
 * @param {object[]} [options.jobs] - Additional job contracts to register.
 * @param {object} [options.ledger] - Job ledger options.
 * @param {string} [options.ledger.tableName='cricket_jobs'] - Ledger table name.
 * @param {object} [options.queues] - Queue driver configuration.
 * @returns {Promise<object>} Worker controls, runtime, driver, and jobs capability.
 */
export async function startCricketWorker(cricketApp, {
  baseUrl,
  clock = {
    now: () => new Date()
  },
  jobs = [],
  ledger: ledgerOptions = {},
  queues = {}
} = {}) {
  let runtime = await createCricketRuntime(cricketApp, {
    baseUrl
  });
  let jobList = [
    ...toArray(runtime.contract.jobs),
    ...toArray(jobs)
  ];
  let driver = await createDriver(queues, jobList);
  let ledger = createJobLedger({
    db: runtime.dependencies.db,
    ...ledgerOptions
  });
  let recordLedger = createLedgerRecorder({
    ledger,
    logger: runtime.logger
  });
  let byName = jobsByName(jobList);

  async function emitJobEvent(type, envelope, metadata = {}) {
    await runtime.observability.emit({
      type,
      jobName: envelope.name,
      ...(metadata.jobRunId ? { jobRunId: metadata.jobRunId } : {}),
      envelopeId: envelope.id,
      queueName: envelope.queueName,
      scheduleKey: envelope.scheduleKey,
      scheduledFor: envelope.scheduledFor,
      availableAt: envelope.availableAt,
      trigger: envelope.trigger,
      requestId: envelope.context?.requestId,
      ...metadata
    });
  }

  let jobsCapability = createJobsCapability({
    driver,
    recordLedger,
    clock
  });

  async function runClaim(claim) {
    let envelope = claim.envelope;
    let job = byName.get(envelope.name);

    if (!job)
      throw new Error(`No job registered for ${envelope.name}`);

    let jobRun = jobRunContext(envelope, `jobrun_${randomUUID()}`);
    let logger = runtime.logger.child({
      jobName: job.name,
      jobRunId: jobRun.jobRunId,
      envelopeId: envelope.id,
      queueName: envelope.queueName,
      attempt: claim.attempt,
      ...(envelope.scheduleKey ? { scheduleKey: envelope.scheduleKey } : {}),
      ...(envelope.scheduledFor ? { scheduledFor: envelope.scheduledFor } : {}),
      ...(jobRun.requestId ? { requestId: jobRun.requestId } : {})
    });
    let replay = runtime.observability.createReplay();
    let trace = createTrace({
      logger,
      replay,
      requestId: jobRun.requestId ?? jobRun.jobRunId,
      context: {
        jobName: job.name,
        jobRunId: jobRun.jobRunId,
        envelopeId: envelope.id,
        queueName: envelope.queueName,
        ...(envelope.scheduleKey ? { scheduleKey: envelope.scheduleKey } : {}),
        ...(envelope.scheduledFor ? { scheduledFor: envelope.scheduledFor } : {})
      }
    });
    let progress = createProgressCapability(driver, recordLedger, envelope, emitJobEvent);

    async function runFailureHandler(phase, error) {
      let handler = job.failure?.[phase];

      if (!handler)
        return;

      let originalError = safeError(error);

      try {
        await trace.span(`job.failure.${phase} ${job.name}`, {}, () => handler(failureContext({
          envelope,
          error,
          attempt: claim.attempt,
          jobRun,
          runtime,
          logger,
          trace,
          jobsCapability,
          progress
        })));
      } catch (handlerError) {
        let failure = safeError(handlerError);

        await emitJobEvent('job.failure_handler_failed', envelope, {
          jobRunId: jobRun.jobRunId,
          attempt: claim.attempt,
          phase,
          error: failure,
          originalError
        });
        logger.error('job.failure_handler_failed', {
          phase,
          error: handlerError,
          originalError
        });
      }
    }

    await recordLedger('started', envelope, ledger => ledger.started(envelope, {
      attempt: claim.attempt,
      jobRunId: jobRun.jobRunId
    }));
    await emitJobEvent('job.started', envelope, {
      jobRunId: jobRun.jobRunId,
      attempt: claim.attempt
    });
    logger.info('job.started');

    try {
      let result = await trace.span(`job.run ${job.name}`, {}, () => job.run({
        input: envelope.input,
        context: envelope.context,
        services: runtime.services,
        logger,
        trace,
        lifecycle: runtime.lifecycle,
        jobs: jobsCapability,
        progress
      }));
      let parsedResult = parseJobResult(job, result);

      await driver.complete(envelope, parsedResult);
      await recordLedger('completed', envelope, ledger => ledger.completed(envelope, {
        result: parsedResult
      }));
      await emitJobEvent('job.completed', envelope, {
        jobRunId: jobRun.jobRunId,
        attempt: claim.attempt
      });
      logger.info('job.completed');

      return parsedResult;
    } catch (error) {
      if (shouldRetry(job, error, envelope, claim.attempt)) {
        let failure = safeError(error);

        await driver.retry(envelope, error);
        await recordLedger('retrying', envelope, ledger => ledger.retrying(envelope, {
          attempt: claim.attempt,
          error: failure
        }));
        await emitJobEvent('job.retry_scheduled', envelope, {
          jobRunId: jobRun.jobRunId,
          attempt: claim.attempt,
          error: failure
        });
        logger.warn('job.retry_scheduled', {
          error
        });
        await runFailureHandler('retrying', error);
        return undefined;
      }

      let failure = safeError(error);

      await driver.fail(envelope, error);
      await recordLedger('failed', envelope, ledger => ledger.failed(envelope, {
        attempt: claim.attempt,
        error: failure
      }));
      await emitJobEvent('job.failed', envelope, {
        jobRunId: jobRun.jobRunId,
        attempt: claim.attempt,
        error: failure
      });
      logger.error('job.failed', {
        error
      });
      await runFailureHandler('exhausted', error);
      throw error;
    }
  }

  async function drain({
    throwOnError = true
  } = {}) {
    let results = [];

    await driver.promoteDelayed?.({
      now: clock.now()
    });

    while (true) {
      let claim = await driver.claim();

      if (!claim)
        return results;

      try {
        results.push(await runClaim(claim));
      } catch (error) {
        if (throwOnError)
          throw error;

        results.push({
          error: safeError(error)
        });
      }
    }
  }

  async function startSchedule(job) {
    let now = clock.now();
    let enabled = job.schedule.enabled
      ? job.schedule.enabled(scheduleContext(runtime, {
        now
      }))
      : true;
    let state = await driver.scheduleState?.(job);
    let lastRunAt = state?.lastRunAt ?? previousCronRun(job.schedule, now);
    let plan = planCronSchedule(job.schedule, {
      lastRunAt,
      now,
      limit: 1
    });

    await driver.registerSchedule?.(job, {
      enabled,
      lastRunAt,
      nextRunAt: plan.nextRunAt
    });

    if (!enabled || !job.schedule.runOnStartup)
      return;

    let scheduledFor = timestamp(now);

    await jobsCapability.enqueue(job, job.schedule.input(scheduleContext(runtime, {
      now,
      scheduledFor
    })), {
      context: {
        source: `schedule:${job.schedule.key}`
      },
      scheduleKey: job.schedule.key,
      scheduledFor,
      trigger: 'startup'
    });
  }

  async function tickSchedules({
    now = clock.now(),
    limit = 10
  } = {}) {
    let materialized = [];

    for (let job of jobList) {
      if (!job.schedule)
        continue;

      let enabled = job.schedule.enabled
        ? job.schedule.enabled(scheduleContext(runtime, {
          now
        }))
        : true;

      if (!enabled)
        continue;

      let state = await driver.scheduleState?.(job);
      let lastRunAt = state?.lastRunAt ?? previousCronRun(job.schedule, now);
      let plan = planCronSchedule(job.schedule, {
        lastRunAt,
        now,
        limit
      });

      for (let slot of plan.due) {
        let envelope = jobsCapability.plan(job, job.schedule.input(scheduleContext(runtime, {
          now,
          scheduledFor: slot.scheduledFor
        })), {
          context: {
            source: `schedule:${job.schedule.key}`
          },
          now: () => now,
          scheduleKey: job.schedule.key,
          scheduledFor: slot.scheduledFor,
          trigger: 'cron',
          createId: () => `jobenv_${slot.slotId.replace(/[^a-zA-Z0-9_:-]/g, '_')}`
        });
        let result = driver.materializeSchedule
          ? await driver.materializeSchedule(envelope, {
            slotId: slot.slotId
          })
          : await driver.enqueue(envelope);

        if (result.enqueued)
          await recordLedger('queued', result.envelope, ledger => ledger.queued(result.envelope));

        materialized.push(result);
      }

      await driver.updateSchedule?.(job, {
        lastRunAt: plan.due.at(-1)?.scheduledFor ?? lastRunAt,
        nextRunAt: plan.nextRunAt,
        missed: plan.missed
      });
    }

    await driver.promoteDelayed?.({
      now
    });

    return materialized;
  }

  async function run({
    intervalMs = 1_000,
    signal,
    throwOnError = false
  } = {}) {
    while (!signal?.aborted) {
      await tickSchedules();
      await drain({
        throwOnError
      });

      try {
        await sleep(intervalMs, undefined, {
          signal
        });
      } catch (error) {
        if (error?.name === 'AbortError')
          return;

        throw error;
      }
    }
  }

  for (let job of jobList) {
    if (job.schedule)
      await startSchedule(job);
  }

  async function cleanup() {
    try {
      await driver.cleanup?.();
    } finally {
      await runtime.cleanup?.();
    }
  }

  return {
    runtime,
    driver,
    ledger,
    jobs: jobsCapability,
    schedules: {
      tick: tickSchedules
    },
    drain,
    run,
    cleanup
  };
}
