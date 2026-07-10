import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  createCricketJobs,
  defineCricketApp,
  defineJob,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { createRedisSocketClient } from '../src/jobs/drivers/redis-client.js';
import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { deferred } from '../test-support/jobs.js';

let redisUrl = process.env.CRICKET_TEST_REDIS_URL;

if (!redisUrl)
  throw new Error('Redis integration tests need CRICKET_TEST_REDIS_URL');

function testPrefix(name) {
  return `cricket:integration:${name}:${randomUUID()}`;
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
    let workerA = await startCricketWorker(defineCricketApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let workerB = await startCricketWorker(defineCricketApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: drivers.driverB }
    });

    try {
      await workerA.jobs.enqueue(job, { reportId: 'first' });
      await workerA.jobs.enqueue(job, { reportId: 'second' });

      let first = workerA.drain({ signal: controller.signal });
      await started.promise;

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

  it('releases idempotency only for the terminal attempt owner', async () => {
    let drivers = await createDrivers('terminal-idempotency');
    let job = reportJob({ idempotent: true });
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });
    let input = {
      reportId: 'report_terminal',
      accountId: 'account_terminal'
    };

    try {
      await producer.jobs.enqueue(job, input);
      let completed = await drivers.driverA.claim();

      assert.equal((await drivers.driverA.complete(completed.envelope, {}, {
        attempt: completed.attempt
      })).settled, true);
      assert.equal((await producer.jobs.enqueue(job, input)).enqueued, true);

      let failed = await drivers.driverA.claim();
      assert.equal((await drivers.driverA.fail(failed.envelope, new Error('terminal'), {
        attempt: failed.attempt
      })).settled, true);
      assert.equal((await producer.jobs.enqueue(job, input)).enqueued, true);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
    }
  });

  it('rejects stale attempt writes after a retry is claimed', async () => {
    let drivers = await createDrivers('attempt-owner');
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: { driver: drivers.driverA }
    });

    try {
      await producer.jobs.enqueue(job, {
        reportId: 'report_attempt',
        accountId: 'account_attempt'
      });

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

      let [candidate] = await drivers.driverB.recoveryCandidates();
      assert.equal(candidate.attempt, second.attempt);
      assert.equal(candidate.leaseActive, true);
      assert.deepEqual(candidate.progress, []);
    } finally {
      await producer.cleanup();
      await drivers.driverB.cleanup();
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
