import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  defineJob,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import { createTestQueueDriver } from '../src/jobs/test-driver.js';
import { createTestState } from '../src/test/index.js';
import {
  createManualClock,
  createTestApp,
  deferred,
  reportJob
} from '../test-support/jobs.js';

describe('Cricket jobs: policy', () => {
  it('keeps idempotency ownership while a run is active', async () => {
    let started = deferred();
    let release = deferred();
    let job = defineJob({
      name: 'reports.activeIdempotency',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      async run() {
        started.resolve();
        await release.promise;

        return { status: 'completed' };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { test: true }
    });

    try {
      let first = await worker.jobs.enqueue(job, { reportId: 'report_active' });
      let draining = worker.drain();

      await started.promise;

      let duplicate = await worker.jobs.enqueue(job, { reportId: 'report_active' });

      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.envelope.id, first.envelope.id);

      release.resolve();
      assert.deepEqual(await draining, [{ status: 'completed' }]);
    } finally {
      release.resolve();
      await worker.cleanup();
    }
  });

  it('keeps idempotency ownership while a run is delayed', async () => {
    let time = createManualClock('2026-06-18T12:00:00.000Z');
    let job = defineJob({
      name: 'reports.delayedIdempotency',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      run() {
        return { status: 'completed' };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      clock: time.clock,
      jobs: [job],
      queues: { test: true }
    });

    try {
      let first = await worker.jobs.enqueue(job, { reportId: 'report_delayed' }, {
        delayMs: 10
      });
      let duplicate = await worker.jobs.enqueue(job, { reportId: 'report_delayed' });

      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.envelope.id, first.envelope.id);
      assert.deepEqual(await worker.drain(), []);

      time.advanceBy(10);
      assert.deepEqual(await worker.drain(), [{ status: 'completed' }]);
      assert.equal((await worker.jobs.enqueue(job, {
        reportId: 'report_delayed'
      })).enqueued, true);
    } finally {
      await worker.cleanup();
    }
  });

  it('claims higher priority first with stable creation and id tie-breaking', async () => {
    let processed = [];
    let older = () => new Date('2026-06-18T11:59:00.000Z');
    let sameTime = () => new Date('2026-06-18T12:00:00.000Z');
    let job = defineJob({
      name: 'reports.priority',
      input: z.object({
        reportId: z.string()
      }),
      context: z.object({
        priority: z.number().int()
      }),
      queue: redisQueue({
        name: 'reports',
        priority: ({ context }) => context.priority
      }),
      run({ input }) {
        processed.push(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'low'
      }, {
        context: { priority: 1 },
        createId: () => 'jobenv_low',
        now: older
      });
      await worker.jobs.enqueue(job, {
        reportId: 'high_old'
      }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_z',
        now: older
      });
      await worker.jobs.enqueue(job, {
        reportId: 'high_b'
      }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_b',
        now: sameTime
      });
      await worker.jobs.enqueue(job, {
        reportId: 'high_a'
      }, {
        context: { priority: 10 },
        createId: () => 'jobenv_high_a',
        now: sameTime
      });

      await worker.drain();

      assert.deepEqual(processed, [
        'high_old',
        'high_a',
        'high_b',
        'low'
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('enforces global concurrency across workers sharing a queue driver', async () => {
    let started = deferred();
    let release = deferred();
    let processed = [];
    let controller = new AbortController();
    let driver = createTestQueueDriver();
    let job = defineJob({
      name: 'reports.globalConcurrency',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      concurrency: concurrency.global({
        key: 'reports:rendering',
        limit: ({ input }) => input.reportId === 'first' ? 1 : 5
      }),
      async run({ input }) {
        if (input.reportId === 'first') {
          started.resolve();
          await release.promise;
        }

        processed.push(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let workerA = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });
    let workerB = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });

    try {
      await workerA.jobs.enqueue(job, { reportId: 'first' }, {
        createId: () => 'jobenv_global_1'
      });
      await workerA.jobs.enqueue(job, { reportId: 'second' }, {
        createId: () => 'jobenv_global_2'
      });

      let first = workerA.drain({ signal: controller.signal });
      await started.promise;

      assert.deepEqual(await workerB.drain(), []);

      controller.abort();
      release.resolve();
      assert.deepEqual(await first, [{ status: 'completed' }]);
      assert.deepEqual(await workerB.drain(), [{ status: 'completed' }]);
      assert.deepEqual(processed, ['first', 'second']);
    } finally {
      release.resolve();
      await workerA.cleanup();
      await workerB.cleanup();
    }
  });

  it('uses available partitions while another partition is at capacity', async () => {
    let started = deferred();
    let release = deferred();
    let controller = new AbortController();
    let driver = createTestQueueDriver();
    let job = defineJob({
      name: 'reports.partitionConcurrency',
      input: z.object({
        reportId: z.string(),
        accountId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      concurrency: concurrency.partition({
        key: ({ input }) => `account:${input.accountId}`,
        limit: 1
      }),
      async run({ input }) {
        if (input.reportId === 'account_a_1') {
          started.resolve();
          await release.promise;
        }

        return {
          reportId: input.reportId
        };
      }
    });
    let workerA = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });
    let workerB = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });

    try {
      await workerA.jobs.enqueue(job, {
        reportId: 'account_a_1',
        accountId: 'a'
      }, { createId: () => 'jobenv_partition_1' });
      await workerA.jobs.enqueue(job, {
        reportId: 'account_a_2',
        accountId: 'a'
      }, { createId: () => 'jobenv_partition_2' });
      await workerA.jobs.enqueue(job, {
        reportId: 'account_b_1',
        accountId: 'b'
      }, { createId: () => 'jobenv_partition_3' });

      let first = workerA.drain({ signal: controller.signal });
      await started.promise;

      assert.deepEqual(await workerB.drain(), [{
        reportId: 'account_b_1'
      }]);

      controller.abort();
      release.resolve();
      await first;
      assert.deepEqual(await workerB.drain(), [{
        reportId: 'account_a_2'
      }]);
    } finally {
      release.resolve();
      await workerA.cleanup();
      await workerB.cleanup();
    }
  });


  it('keeps delayed jobs out of the ready queue until they are available', async () => {
    let now = new Date('2026-06-19T12:00:00.000Z');
    let job = reportJob();
    let worker = await startCricketWorker(createTestApp(createTestState(), [job]), {
      clock: {
        now: () => now
      },
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_delayed',
        accountId: 'acct_delayed',
        templateId: 'template_delayed'
      }, {
        delayMs: 60_000
      });

      assert.deepEqual(await worker.drain(), []);

      now = new Date('2026-06-19T12:01:00.000Z');

      assert.deepEqual(await worker.drain(), [
        {
          status: 'completed'
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });
});
