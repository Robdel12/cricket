import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  createCricketJobs,
  defineJob,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import { createRedisSocketClient } from '../src/jobs/drivers/redis-client.js';
import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { createManualClock, deferred } from '../test-support/jobs.js';

let redisUrl = process.env.CRICKET_TEST_REDIS_URL;

if (!redisUrl)
  throw new Error('Redis integration tests need CRICKET_TEST_REDIS_URL');

function testPrefix(name) {
  return `cricket:integration:${name}:${randomUUID()}`;
}

function jobRecordKeys(prefix, id) {
  return [
    'envelope',
    'run',
    'lease',
    'events',
    'logs',
    'spans',
    'progress'
  ].map(type => `${prefix}:${type}:${id}`);
}

function reportJob({
  concurrency: concurrencyPolicy,
  idempotent = false
} = {}) {
  return defineJob({
    name: 'reports.generate',
    input: z.object({
      reportId: z.string(),
      accountId: z.string()
    }),
    queue: redisQueue({
      name: 'reports',
      ...(idempotent ? {
        idempotencyKey: ({ input }) => input.reportId
      } : {})
    }),
    ...(concurrencyPolicy ? { concurrency: concurrencyPolicy } : {}),
    run() {}
  });
}

async function createDrivers(name, queueNames = ['reports']) {
  let prefix = testPrefix(name);
  let driverA = await createRedisQueueDriver({
    url: redisUrl,
    prefix,
    queueNames
  });
  let driverB;

  try {
    driverB = await createRedisQueueDriver({
      url: redisUrl,
      prefix,
      queueNames
    });
  } catch (error) {
    await driverA.cleanup();
    throw error;
  }

  return {
    driverA,
    driverB,
    prefix
  };
}

describe('Cricket jobs: real Redis', () => {
  it('keeps app-owned Redis clients open while owning their blocking duplicate', async () => {
    let prefix = testPrefix('app-client');
    let main = await createRedisSocketClient(redisUrl);
    let blocking = deferred();
    let duplicateClosed = false;
    let client = {
      async command(name, ...args) {
        return await main.command(name, ...args);
      },
      async duplicate() {
        let duplicate = await createRedisSocketClient(redisUrl);

        return {
          async command(name, ...args) {
            if (name === 'BLPOP')
              blocking.resolve();

            return await duplicate.command(name, ...args);
          },
          async disconnect() {
            duplicateClosed = true;
            await duplicate.disconnect();
          }
        };
      }
    };
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: {
        redis: {
          client,
          prefix
        }
      }
    });
    let cleaned = false;

    try {
      let waiting = producer.driver.waitForWork();
      await blocking.promise;

      await producer.jobs.enqueue(job, {
        reportId: 'report_app_client',
        accountId: 'account_app_client'
      });
      assert.deepEqual(await waiting, {
        reason: 'work',
        queueName: 'reports'
      });

      await producer.cleanup();
      cleaned = true;

      assert.equal(duplicateClosed, true);
      assert.equal(await main.command('PING'), 'PONG');
    } finally {
      if (!cleaned)
        await producer.cleanup();

      await main.quit();
    }
  });

  it('atomically owns one idempotent enqueue across producers', async () => {
    let drivers = await createDrivers('idempotency');
    let job = reportJob({ idempotent: true });
    let producerA = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let producerB = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverB }
    });
    let input = {
      reportId: 'report_shared',
      accountId: 'account_shared'
    };

    try {
      let results = await Promise.all([
        producerA.jobs.enqueue(job, input),
        producerB.jobs.enqueue(job, input)
      ]);
      let enqueued = results.find(result => result.enqueued);
      let duplicate = results.find(result => result.duplicate);

      assert.ok(enqueued);
      assert.ok(duplicate);
      assert.equal(duplicate.envelope.id, enqueued.envelope.id);
    } finally {
      await producerA.cleanup();
      await producerB.cleanup();
    }
  });

  it('atomically enforces partition capacity across concurrent claimers', async () => {
    let drivers = await createDrivers('capacity');
    let job = reportJob({
      concurrency: concurrency.partition({
        key: ({ input }) => `account:${input.accountId}`,
        limit: 1
      })
    });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });

    try {
      await producer.jobs.enqueue(job, {
        reportId: 'report_1',
        accountId: 'account_a'
      });
      await producer.jobs.enqueue(job, {
        reportId: 'report_2',
        accountId: 'account_a'
      });

      let claims = await Promise.all([
        drivers.driverA.claim(),
        drivers.driverB.claim()
      ]);
      let active = claims.filter(Boolean);

      assert.equal(active.length, 1);
      assert.equal(await drivers.driverB.claim(), undefined);

      assert.equal((await drivers.driverA.complete(active[0].envelope, {}, {
        attempt: active[0].attempt
      })).settled, true);

      let next = await drivers.driverB.claim();
      assert.ok(next);
      assert.notEqual(next.envelope.id, active[0].envelope.id);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('runs concurrent workers without exceeding shared capacity', async () => {
    let drivers = await createDrivers('workers');
    let started = deferred();
    let release = deferred();
    let controller = new AbortController();
    let processed = [];
    let job = defineJob({
      name: 'reports.workerCapacity',
      input: z.object({ reportId: z.string() }),
      queue: redisQueue({ name: 'reports' }),
      concurrency: concurrency.global({
        key: 'reports:rendering',
        limit: 1
      }),
      async run({ input }) {
        if (input.reportId === 'first') {
          started.resolve();
          await release.promise;
        }

        processed.push(input.reportId);
        return { status: 'completed' };
      }
    });
    let workerA = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let workerB = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: drivers.driverB }
    });

    try {
      await workerA.jobs.enqueue(job, { reportId: 'first' });

      let first = workerA.drain({ signal: controller.signal });
      await started.promise;

      await workerA.jobs.enqueue(job, { reportId: 'second' });
      assert.deepEqual(await workerB.drain(), []);

      controller.abort();
      release.resolve();
      assert.deepEqual(await first, [{ status: 'completed' }]);
      assert.deepEqual(await workerB.drain(), [{ status: 'completed' }]);
      assert.deepEqual(processed, ['first', 'second']);
    } finally {
      controller.abort();
      release.resolve();
      await workerA.cleanup();
      await workerB.cleanup();
    }
  });

  it('claims ready work by priority with deterministic ties', async () => {
    let drivers = await createDrivers('priority');
    let job = defineJob({
      name: 'reports.priority',
      input: z.object({ reportId: z.string() }),
      context: z.object({ priority: z.number().int() }),
      queue: redisQueue({
        name: 'reports',
        priority: ({ context }) => context.priority
      }),
      run() {}
    });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let older = () => new Date('2026-07-10T04:59:00.000Z');
    let sameTime = () => new Date('2026-07-10T05:00:00.000Z');

    try {
      await producer.jobs.enqueue(job, { reportId: 'low' }, {
        context: { priority: 1 },
        createId: () => 'jobenv_low',
        now: older
      });
      await producer.jobs.enqueue(job, { reportId: 'high_old' }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_z',
        now: older
      });
      await producer.jobs.enqueue(job, { reportId: 'high_b' }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_b',
        now: sameTime
      });
      await producer.jobs.enqueue(job, { reportId: 'high_a' }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_a',
        now: sameTime
      });

      let first = await drivers.driverA.claim();
      let second;
      let third;

      assert.equal(first.envelope.input.reportId, 'high_old');
      await drivers.driverA.complete(first.envelope, {}, { attempt: first.attempt });

      second = await drivers.driverA.claim();
      assert.equal(second.envelope.input.reportId, 'high_a');
      await drivers.driverA.complete(second.envelope, {}, { attempt: second.attempt });

      third = await drivers.driverA.claim();
      assert.equal(third.envelope.input.reportId, 'high_b');
      await drivers.driverA.complete(third.envelope, {}, { attempt: third.attempt });

      assert.equal((await drivers.driverA.claim()).envelope.input.reportId, 'low');
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('releases idempotency only for the finished attempt owner', async () => {
    let drivers = await createDrivers('finished-idempotency');
    let job = reportJob({ idempotent: true });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let input = {
      reportId: 'report_finished',
      accountId: 'account_finished'
    };

    try {
      await producer.jobs.enqueue(job, input);
      let completed = await drivers.driverA.claim();

      assert.equal((await drivers.driverA.complete(completed.envelope, {}, {
        attempt: completed.attempt
      })).settled, true);
      assert.equal((await producer.jobs.enqueue(job, input)).enqueued, true);

      let failed = await drivers.driverA.claim();
      assert.equal((await drivers.driverA.fail(failed.envelope, new Error('finished'), {
        attempt: failed.attempt
      })).settled, true);
      assert.equal((await producer.jobs.enqueue(job, input)).enqueued, true);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('keeps idempotency ownership fenced to the current attempt', async () => {
    let drivers = await createDrivers('attempt-owner');
    let job = reportJob({ idempotent: true });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let input = {
      reportId: 'report_attempt',
      accountId: 'account_attempt'
    };

    try {
      await producer.jobs.enqueue(job, input);

      let first = await drivers.driverA.claim();
      assert.equal((await drivers.driverA.retry(first.envelope, {
        attempt: first.attempt,
        availableAt: first.envelope.createdAt,
        now: first.envelope.createdAt
      })).settled, true);

      let second = await drivers.driverB.claim();
      assert.equal(second.attempt, 2);
      assert.equal((await drivers.driverA.complete(first.envelope, {}, {
        attempt: first.attempt
      })).settled, false);
      assert.equal((await drivers.driverA.progress(first.envelope, {
        stale: true
      }, { attempt: first.attempt })).recorded, false);
      assert.equal((await drivers.driverA.heartbeat(first.envelope, {
        attempt: first.attempt
      })).renewed, false);

      let duplicate = await producer.jobs.enqueue(job, input);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.envelope.id, second.envelope.id);

      let [candidate] = await drivers.driverB.recoveryCandidates();
      assert.equal(candidate.attempt, second.attempt);
      assert.equal(candidate.leaseActive, true);
      assert.deepEqual(candidate.progress, []);

      assert.equal((await drivers.driverB.complete(second.envelope, {}, {
        attempt: second.attempt
      })).settled, true);
      assert.equal((await producer.jobs.enqueue(job, input)).enqueued, true);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('recovers and retries through the public Redis worker boundary', async () => {
    let prefix = testPrefix('recovery-workflow');
    let admin = await createRedisSocketClient(redisUrl);
    let secondStarted = deferred();
    let finishSecond = deferred();
    let recoveryFacts = [];
    let recoveryEvents = [];
    let job = defineJob({
      name: 'reports.redisRecovery',
      input: z.object({ reportId: z.string() }),
      queue: redisQueue({ name: 'reports' }),
      recover({
        run,
        logs,
        progress
      }) {
        recoveryFacts.push({
          leaseActive: run.leaseActive,
          sawFirstLog: logs.seen('report.first_started'),
          lastProgress: progress.last()?.progress.phase
        });

        return {
          action: 'retry',
          reason: {
            code: 'interrupted_attempt',
            message: 'The first attempt lost its lease'
          }
        };
      },
      async run({
        logger,
        progress
      }) {
        logger.info('report.second_started');
        await progress.update({ phase: 'second' });
        secondStarted.resolve();
        await finishSecond.promise;

        return { status: 'completed' };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {},
      observability: {
        observe(event) {
          if (event.type === 'job.recovery.decided')
            recoveryEvents.push(event);
        }
      }
    }), {
      jobs: [job],
      queues: {
        redis: {
          url: redisUrl,
          prefix
        }
      }
    });

    try {
      await worker.jobs.enqueue(job, { reportId: 'report_recovery' });
      let first = await worker.driver.claim();

      await worker.driver.recordLog(first.envelope, {
        level: 'info',
        event: 'report.first_started'
      }, { attempt: first.attempt });
      await worker.driver.progress(first.envelope, {
        phase: 'first'
      }, { attempt: first.attempt });

      let fenced = await worker.recover();
      assert.equal(fenced[0].decision.action, 'retry');
      assert.equal(fenced[0].applied, false);

      await admin.command('DEL', `${prefix}:lease:${first.envelope.id}`);

      let recovered = await worker.recover();
      assert.equal(recovered[0].decision.action, 'retry');
      assert.equal(recovered[0].applied, true);
      assert.deepEqual(recoveryFacts, [
        {
          leaseActive: true,
          sawFirstLog: true,
          lastProgress: 'first'
        },
        {
          leaseActive: false,
          sawFirstLog: true,
          lastProgress: 'first'
        }
      ]);
      assert.deepEqual(recoveryEvents.map(event => event.applied), [false, true]);

      let draining = worker.drain();
      await secondStarted.promise;

      let [active] = await worker.driver.recoveryCandidates();
      assert.equal(active.attempt, 2);
      assert.equal(active.logs.some(log => log.event === 'report.first_started'), false);
      assert.equal(active.logs.some(log => log.event === 'report.second_started'), true);
      assert.deepEqual(active.progress.map(entry => entry.progress.phase), ['second']);

      finishSecond.resolve();
      assert.deepEqual(await draining, [{ status: 'completed' }]);
    } finally {
      finishSecond.resolve();
      await admin.quit();
      await worker.cleanup();
    }
  });

  it('fences a worker after its lease disappears', async () => {
    let drivers = await createDrivers('lease-fence');
    let admin = await createRedisSocketClient(redisUrl);
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });

    try {
      await producer.jobs.enqueue(job, {
        reportId: 'report_lease',
        accountId: 'account_lease'
      });
      let claim = await drivers.driverA.claim();

      await admin.command('DEL', `${drivers.prefix}:lease:${claim.envelope.id}`);

      assert.equal((await drivers.driverA.heartbeat(claim.envelope, {
        attempt: claim.attempt
      })).renewed, false);
      assert.equal((await drivers.driverA.complete(claim.envelope, {}, {
        attempt: claim.attempt
      })).settled, false);
      assert.equal((await drivers.driverA.progress(claim.envelope, {}, {
        attempt: claim.attempt
      })).recorded, false);
      assert.equal((await drivers.driverA.recoveryCandidates())[0].leaseActive, false);

      await admin.command(
        'SET',
        `${drivers.prefix}:lease:${claim.envelope.id}`,
        String(claim.attempt),
        'EX',
        '60'
      );
      assert.equal((await drivers.driverB.retry(claim.envelope, {
        attempt: claim.attempt,
        availableAt: claim.envelope.createdAt,
        now: claim.envelope.createdAt,
        recovering: true
      })).settled, false);

      await admin.command('DEL', `${drivers.prefix}:lease:${claim.envelope.id}`);
      assert.equal((await drivers.driverB.retry(claim.envelope, {
        attempt: claim.attempt,
        availableAt: claim.envelope.createdAt,
        now: claim.envelope.createdAt,
        recovering: true
      })).settled, true);
      assert.equal((await drivers.driverB.claim()).attempt, 2);
    } finally {
      await admin.quit();
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('promotes each delayed retry once under concurrent promotion', async () => {
    let drivers = await createDrivers('delayed');
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });

    try {
      await producer.jobs.enqueue(job, {
        reportId: 'report_delayed',
        accountId: 'account_delayed'
      });
      let first = await drivers.driverA.claim();
      let availableAt = new Date(new Date(first.envelope.createdAt).getTime() + 10).toISOString();

      assert.equal((await drivers.driverA.retry(first.envelope, {
        attempt: first.attempt,
        availableAt,
        now: first.envelope.createdAt
      })).settled, true);
      assert.equal(await drivers.driverB.claim(), undefined);

      let promoted = await Promise.all([
        drivers.driverA.promoteDelayed({ now: availableAt }),
        drivers.driverB.promoteDelayed({ now: availableAt })
      ]);

      assert.equal(promoted.flat().length, 1);
      assert.equal((await drivers.driverB.claim()).attempt, 2);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('drains every due retry across bounded promotion batches', async () => {
    let prefix = testPrefix('delayed-batches');
    let time = createManualClock('2026-07-10T05:00:00.000Z');
    let availableAt = '2026-07-10T05:01:00.000Z';
    let processed = [];
    let job = defineJob({
      name: 'reports.delayedBatch',
      input: z.object({ reportId: z.string() }),
      queue: redisQueue({ name: 'reports' }),
      run({ input }) {
        processed.push(input.reportId);
        return { status: 'completed' };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        redis: {
          url: redisUrl,
          prefix
        }
      }
    });

    try {
      for (let index = 0; index < 101; index += 1) {
        await worker.jobs.enqueue(job, { reportId: `report_${index}` });
        let claim = await worker.driver.claim();

        assert.equal((await worker.driver.retry(claim.envelope, {
          attempt: claim.attempt,
          availableAt,
          now: time.now()
        })).settled, true);
      }

      time.advanceTo(availableAt);

      let results = await worker.drain();
      assert.equal(results.length, 101);
      assert.equal(processed.length, 101);
    } finally {
      await worker.cleanup();
    }
  });

  it('removes finished job records and releases their schedule slots', async () => {
    let drivers = await createDrivers('remove-finished');
    let admin = await createRedisSocketClient(redisUrl);
    let job = reportJob({ idempotent: true });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let scheduledFor = '2026-07-10T05:00:00.000Z';
    let slotId = `daily_report:${scheduledFor}`;
    let scheduled = producer.jobs.plan(job, {
      reportId: 'report_finished_schedule',
      accountId: 'account_finished_schedule'
    }, {
      createId: () => 'jobenv_finished_schedule',
      scheduleKey: 'daily_report',
      scheduledFor
    });

    try {
      await drivers.driverA.materializeSchedule(scheduled, { slotId });
      let completedClaim = await drivers.driverA.claim();

      await drivers.driverA.recordLog(completedClaim.envelope, {
        event: 'report.started'
      }, {
        attempt: completedClaim.attempt
      });
      await drivers.driverA.recordSpan(completedClaim.envelope, {
        name: 'report.rendered'
      }, {
        attempt: completedClaim.attempt
      });
      await drivers.driverA.progress(completedClaim.envelope, {
        current: 1,
        total: 2
      }, {
        attempt: completedClaim.attempt
      });
      await drivers.driverA.complete(completedClaim.envelope, {
        status: 'completed'
      }, {
        attempt: completedClaim.attempt
      });

      let failed = await producer.jobs.enqueue(job, {
        reportId: 'report_finished_failure',
        accountId: 'account_finished_failure'
      });
      let failedClaim = await drivers.driverA.claim();

      await drivers.driverA.recordLog(failedClaim.envelope, {
        event: 'report.failed'
      }, {
        attempt: failedClaim.attempt
      });
      await drivers.driverA.fail(failedClaim.envelope, new Error('render failed'), {
        attempt: failedClaim.attempt
      });

      assert.deepEqual(await producer.jobs.removeFinished([
        scheduled.id,
        failed.envelope.id
      ]), {
        removed: [
          scheduled.id,
          failed.envelope.id
        ],
        missing: [],
        skipped: []
      });

      for (let id of [scheduled.id, failed.envelope.id]) {
        assert.equal(await admin.command(
          'EXISTS',
          ...jobRecordKeys(drivers.prefix, id)
        ), 0);
      }

      assert.equal(await admin.command(
        'EXISTS',
        `${drivers.prefix}:schedule:slot:${slotId}`
      ), 0);
      assert.deepEqual(await producer.jobs.removeFinished([scheduled.id]), {
        removed: [],
        missing: [scheduled.id],
        skipped: []
      });

      let replacement = producer.jobs.plan(job, {
        reportId: 'report_finished_schedule_replacement',
        accountId: 'account_finished_schedule'
      }, {
        createId: () => 'jobenv_finished_schedule_replacement',
        scheduleKey: 'daily_report',
        scheduledFor
      });
      let rematerialized = await drivers.driverA.materializeSchedule(replacement, { slotId });

      assert.equal(rematerialized.enqueued, true);
      assert.equal(rematerialized.envelope.id, replacement.id);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
      await admin.quit();
    }
  });

  it('keeps unfinished Redis jobs when finished-job cleanup runs', async () => {
    let drivers = await createDrivers('keep-unfinished');
    let admin = await createRedisSocketClient(redisUrl);
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });

    try {
      let active = await producer.jobs.enqueue(job, {
        reportId: 'report_active',
        accountId: 'account_active'
      });
      await drivers.driverA.claim();
      let retrying = await producer.jobs.enqueue(job, {
        reportId: 'report_retrying',
        accountId: 'account_retrying'
      });
      let retryingClaim = await drivers.driverA.claim();
      await drivers.driverA.retry(retryingClaim.envelope, {
        attempt: retryingClaim.attempt,
        availableAt: '2099-01-01T00:00:00.000Z'
      });
      let queued = await producer.jobs.enqueue(job, {
        reportId: 'report_queued',
        accountId: 'account_queued'
      });
      let delayed = await producer.jobs.enqueue(job, {
        reportId: 'report_delayed',
        accountId: 'account_delayed'
      }, {
        runAt: '2099-01-01T00:00:00.000Z'
      });
      let ids = [
        active.envelope.id,
        retrying.envelope.id,
        queued.envelope.id,
        delayed.envelope.id
      ];

      assert.deepEqual(await producer.jobs.removeFinished(ids), {
        removed: [],
        missing: [],
        skipped: ids.map(id => ({
          id,
          reason: 'not_finished'
        }))
      });

      for (let id of ids) {
        assert.equal(await admin.command(
          'EXISTS',
          `${drivers.prefix}:envelope:${id}`,
          `${drivers.prefix}:run:${id}`
        ), 2);
      }
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
      await admin.quit();
    }
  });

  it('materializes one durable envelope for a schedule slot', async () => {
    let drivers = await createDrivers('schedule');
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let input = {
      reportId: 'report_schedule',
      accountId: 'account_schedule'
    };
    let scheduledFor = '2026-07-10T05:00:00.000Z';
    let envelopeA = producer.jobs.plan(job, input, {
      createId: () => 'jobenv_schedule_a',
      scheduleKey: 'daily_report',
      scheduledFor
    });
    let envelopeB = producer.jobs.plan(job, input, {
      createId: () => 'jobenv_schedule_b',
      scheduleKey: 'daily_report',
      scheduledFor
    });

    try {
      let results = await Promise.all([
        drivers.driverA.materializeSchedule(envelopeA, {
          slotId: `daily_report:${scheduledFor}`
        }),
        drivers.driverB.materializeSchedule(envelopeB, {
          slotId: `daily_report:${scheduledFor}`
        })
      ]);
      let enqueued = results.find(result => result.enqueued);
      let duplicate = results.find(result => result.duplicate);

      assert.ok(enqueued);
      assert.ok(duplicate);
      assert.equal(duplicate.envelope.id, enqueued.envelope.id);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });
});
