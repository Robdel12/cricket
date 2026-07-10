import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCricketJobs,
  cronSchedule,
  defineCricketApp,
  defineJob,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { createTestQueueDriver } from '../src/jobs/test-driver.js';
import { createTestState } from '../src/test/index.js';
import {
  createManualClock,
  createTestApp,
  deferred,
  reportJob
} from '../test-support/jobs.js';

describe('Cricket jobs: worker', () => {
  it('requires an explicit queue driver for producers and workers', async () => {
    let job = reportJob();

    await assert.rejects(
      createCricketJobs({
        jobs: [job]
      }),
      /queues\.driver, queues\.redis, or explicit queues\.test/
    );
    await assert.rejects(
      startCricketWorker(defineCricketApp({}), {
        jobs: [job]
      }),
      /queues\.driver, queues\.redis, or explicit queues\.test/
    );
  });


  it('requires custom worker clocks to own deadline waits', async () => {
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      clock: {
        now: () => new Date('2026-06-18T12:00:00.000Z')
      },
      queues: {
        test: true
      }
    });

    try {
      await assert.rejects(
        worker.run(),
        /custom clock\.now needs clock\.waitUntil/
      );
    } finally {
      await worker.cleanup();
    }
  });


  it('runs jobs through Cricket services, logger, trace, progress, and test state', async () => {
    let processed = [];
    let testState = createTestState();
    let job = reportJob(processed);
    let app = createTestApp(testState);
    let worker = await startCricketWorker(app, {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      let first = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      }, {
        context: {
          requestId: 'req_job_1',
          source: 'report.requested',
          priority: 10
        }
      });
      let duplicate = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      }, {
        context: {
          requestId: 'req_job_1',
          source: 'report.requested',
          priority: 10
        }
      });

      assert.equal(first.enqueued, true);
      assert.equal(duplicate.duplicate, true);

      let results = await worker.drain();

      assert.deepEqual(results, [
        {
          status: 'completed'
        }
      ]);
      assert.deepEqual(processed, ['report_123']);
      let afterCompletion = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      });

      assert.equal(afterCompletion.enqueued, true);
      assert.ok(testState.jobs().some(event => event.type === 'job.completed'));
      assert.ok(testState.jobs().some(event => event.type === 'job.progressed'));
      assert.ok(testState.logs().some(log => log.event === 'report.started'));
      assert.ok(testState.events().some(event => event.type === 'trace.span.finished'));
    } finally {
      await worker.cleanup();
    }
  });


  it('wakes the worker loop for enqueued work and stops on abort', async () => {
    let waiting = deferred();
    let completed = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let job = defineJob({
      name: 'reports.eventDriven',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        driver
      }
    });
    let controller = new AbortController();

    try {
      let running = worker.run({
        signal: controller.signal
      });

      await waiting.promise;
      await worker.jobs.enqueue(job, {
        reportId: 'report_event_driven'
      });
      assert.equal(await completed.promise, 'report_event_driven');

      controller.abort();
      await running;

      assert.equal(driver.snapshot().items[0].status, 'completed');
    } finally {
      await worker.cleanup();
    }
  });

  it('stops a blocked worker loop when cleanup begins', async () => {
    let waiting = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      queues: {
        driver
      }
    });
    let cleaned = false;

    try {
      let running = worker.run();

      await waiting.promise;
      await worker.cleanup();
      cleaned = true;
      await running;
    } finally {
      if (!cleaned)
        await worker.cleanup();
    }
  });

  it('recomputes its deadline when delayed work arrives after waiting starts', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let waiting = deferred();
    let completed = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let job = defineJob({
      name: 'reports.lateDelayedBoundary',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        driver
      }
    });
    let controller = new AbortController();

    try {
      let running = worker.run({
        signal: controller.signal
      });

      await waiting.promise;
      let nextWait = time.nextWait();
      await worker.jobs.enqueue(job, {
        reportId: 'report_late_delayed_boundary'
      }, {
        delayMs: 60_000
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T12:01:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, 'report_late_delayed_boundary');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('wakes the worker loop at the next delayed boundary', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let completed = deferred();
    let job = defineJob({
      name: 'reports.delayedBoundary',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });
    let controller = new AbortController();

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_delayed_boundary'
      }, {
        delayMs: 60_000
      });
      let nextWait = time.nextWait();
      let running = worker.run({
        signal: controller.signal
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T12:01:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, 'report_delayed_boundary');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('wakes the worker loop at the next cron boundary', async () => {
    let time = createManualClock('2026-06-19T09:14:00.000Z');
    let completed = deferred();
    let job = defineJob({
      name: 'maintenance.scheduledBoundary',
      input: z.object({
        scheduledFor: z.string()
      }),
      queue: redisQueue({
        name: 'maintenance'
      }),
      schedule: cronSchedule({
        key: 'scheduled_boundary',
        cron: '15 4 * * *',
        timezone: 'America/Chicago',
        input: ({ scheduledFor }) => ({
          scheduledFor
        })
      }),
      run({ input }) {
        completed.resolve(input.scheduledFor);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });
    let controller = new AbortController();

    try {
      let nextWait = time.nextWait();
      let running = worker.run({
        signal: controller.signal
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T09:15:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, '2026-06-19T09:15:00.000Z');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('renews active job heartbeats through the injected clock lifecycle', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let started = deferred();
    let release = deferred();
    let renewed = deferred();
    let heartbeatCount = 0;
    let baseDriver = createTestQueueDriver();
    let heartbeat = baseDriver.heartbeat.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async heartbeat(...args) {
        await heartbeat(...args);
        heartbeatCount += 1;

        if (heartbeatCount === 2)
          renewed.resolve();
      }
    };
    let job = defineJob({
      name: 'reports.longRunning',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async run() {
        started.resolve();
        await release.promise;
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        driver
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_long_running'
      });
      let nextHeartbeat = time.nextWait();
      let draining = worker.drain();

      await started.promise;
      assert.equal(
        (await nextHeartbeat).toISOString(),
        '2026-06-19T12:00:15.000Z'
      );
      time.advanceBy(15_000);
      await renewed.promise;

      let [candidate] = await driver.recoveryCandidates();
      assert.equal(candidate.lastHeartbeatAt, '2026-06-19T12:00:15.000Z');

      release.resolve();
      assert.deepEqual(await draining, [{
        status: 'completed'
      }]);
    } finally {
      release.resolve();
      await worker.cleanup();
    }
  });

  it('waits for active claims to settle before closing worker resources', async () => {
    let started = deferred();
    let release = deferred();
    let order = [];
    let baseDriver = createTestQueueDriver();
    let complete = baseDriver.complete.bind(baseDriver);
    let cleanup = baseDriver.cleanup.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async complete(...args) {
        let result = await complete(...args);
        order.push('completed');
        return result;
      },
      async cleanup() {
        order.push('cleanup');
        await cleanup();
      }
    };
    let job = defineJob({
      name: 'reports.gracefulCleanup',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async run() {
        started.resolve();
        await release.promise;
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        driver
      }
    });

    await worker.jobs.enqueue(job, {
      reportId: 'report_graceful_cleanup'
    });
    let draining = worker.drain();

    await started.promise;
    let cleaning = worker.cleanup();

    release.resolve();
    await Promise.all([draining, cleaning]);

    assert.deepEqual(order, [
      'completed',
      'cleanup'
    ]);
  });

});
