import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defineCricketApp,
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { createTestState } from '../src/test/index.js';
import {
  createManualClock,
  createTestApp
} from '../test-support/jobs.js';

describe('Cricket jobs: failure', () => {
  it('can drain worker failures without stopping the worker process', async () => {
    let testState = createTestState();
    let job = defineJob({
      name: 'reports.fail',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      async run() {
        throw new Error('renderer unavailable');
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_failed'
      });

      assert.deepEqual(await worker.drain({ throwOnError: false }), [
        {
          error: {
            name: 'Error',
            message: 'renderer unavailable'
          }
        }
      ]);
      assert.ok(testState.jobs().some(event => event.type === 'job.failed'));
    } finally {
      await worker.cleanup();
    }
  });

  it('runs retrying failure handlers after Cricket schedules retry work', async () => {
    let productEvents = [];
    let attempts = 0;
    let time = createManualClock('2026-06-18T12:00:00.000Z');
    let job = defineJob({
      name: 'reports.retry',
      input: z.object({
        reportId: z.string()
      }),
      result: z.object({
        status: z.enum(['completed'])
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      retry: retry.exponential({
        attempts: 2,
        delayMs: 10
      }),
      failure: jobFailure({
        async retrying({ input, attempt, failure, services }) {
          productEvents.push(services.reports.markRetrying({
            reportId: input.reportId,
            attempt,
            reason: failure.message
          }));
        },
        async exhausted() {
          productEvents.push({
            status: 'unexpected'
          });
        }
      }),
      async run() {
        attempts += 1;

        if (attempts === 1)
          throw new Error('renderer warming up');

        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {},
      services() {
        return {
          reports: {
            markRetrying(event) {
              return {
                status: 'queued',
                ...event
              };
            }
          }
        };
      }
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_retry'
      });

      let originalAvailableAt = worker.driver.snapshot().items[0].envelope.availableAt;

      assert.deepEqual(await worker.drain(), [undefined]);
      assert.deepEqual(await worker.drain(), []);
      assert.equal(worker.driver.snapshot().items[0].availableAt, '2026-06-18T12:00:00.010Z');
      assert.equal(worker.driver.snapshot().items[0].envelope.availableAt, originalAvailableAt);

      let retryDuplicate = await worker.jobs.enqueue(job, {
        reportId: 'report_retry'
      });

      assert.equal(retryDuplicate.duplicate, true);

      time.advanceBy(9);
      assert.deepEqual(await worker.drain(), []);

      time.advanceBy(1);
      assert.deepEqual(await worker.drain(), [{
        status: 'completed'
      }]);
      assert.deepEqual(productEvents, [
        {
          status: 'queued',
          reportId: 'report_retry',
          attempt: 1,
          reason: 'renderer warming up'
        }
      ]);
      assert.deepEqual(worker.driver.snapshot().events.map(event => event.type), [
        'queued',
        'claimed',
        'retry_scheduled',
        'delay_promoted',
        'claimed',
        'completed'
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('applies exponential retry delays and caps them at the policy maximum', async () => {
    let time = createManualClock('2026-06-18T12:00:00.000Z');
    let attempts = 0;
    let job = defineJob({
      name: 'reports.backoff',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      retry: retry.exponential({
        attempts: 4,
        delayMs: 10,
        maxDelayMs: 25
      }),
      run() {
        attempts += 1;

        if (attempts < 4)
          throw new Error(`attempt ${attempts} failed`);

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

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_backoff'
      });

      assert.deepEqual(await worker.drain(), [undefined]);
      assert.equal(worker.driver.snapshot().items[0].availableAt, '2026-06-18T12:00:00.010Z');

      time.advanceBy(10);
      assert.deepEqual(await worker.drain(), [undefined]);
      assert.equal(worker.driver.snapshot().items[0].availableAt, '2026-06-18T12:00:00.030Z');

      time.advanceBy(20);
      assert.deepEqual(await worker.drain(), [undefined]);
      assert.equal(worker.driver.snapshot().items[0].availableAt, '2026-06-18T12:00:00.055Z');

      time.advanceBy(24);
      assert.deepEqual(await worker.drain(), []);

      time.advanceBy(1);
      assert.deepEqual(await worker.drain(), [{
        status: 'completed'
      }]);
      assert.equal(attempts, 4);
    } finally {
      await worker.cleanup();
    }
  });


  it('runs exhausted failure handlers after Cricket marks final failures', async () => {
    let productEvents = [];
    let job = defineJob({
      name: 'reports.exhaust',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      failure: jobFailure({
        async exhausted({ input, attempt, failure, services }) {
          productEvents.push(services.reports.markFailed({
            reportId: input.reportId,
            attempt,
            reason: failure.message
          }));
        }
      }),
      async run() {
        throw new Error('renderer offline');
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {},
      services() {
        return {
          reports: {
            markFailed(event) {
              return {
                status: 'failed',
                ...event
              };
            }
          }
        };
      }
    }), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_exhausted'
      });

      assert.deepEqual(await worker.drain({ throwOnError: false }), [
        {
          error: {
            name: 'Error',
            message: 'renderer offline'
          }
        }
      ]);
      assert.deepEqual(productEvents, [
        {
          status: 'failed',
          reportId: 'report_exhausted',
          attempt: 1,
          reason: 'renderer offline'
        }
      ]);
      assert.equal(worker.driver.snapshot().items[0].status, 'failed');
    } finally {
      await worker.cleanup();
    }
  });

  it('keeps failure handler errors from replacing the original job error', async () => {
    let testState = createTestState();
    let logs = [];
    let job = defineJob({
      name: 'reports.handlerFail',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports',
        idempotencyKey: ({ input }) => input.reportId
      }),
      failure: jobFailure({
        async exhausted() {
          throw new Error('product sync failed');
        }
      }),
      async run() {
        throw new Error('renderer offline');
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      observability: {
        observe(event) {
          testState.recordEvent(event);
        }
      },
      logger: {
        info() {},
        warn() {},
        error(event, metadata) {
          logs.push({
            event,
            metadata
          });
        },
        child() {
          return this;
        }
      }
    }), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_handler_failure'
      });

      assert.deepEqual(await worker.drain({ throwOnError: false }), [
        {
          error: {
            name: 'Error',
            message: 'renderer offline'
          }
        }
      ]);
      assert.ok(logs.some(log =>
        log.event === 'job.failure_handler_failed' &&
        log.metadata.phase === 'exhausted' &&
        log.metadata.originalError.message === 'renderer offline'
      ));
      assert.ok(testState.events().some(event =>
        event.type === 'job.failure_handler_failed' &&
        event.phase === 'exhausted' &&
        event.error.message === 'product sync failed'
      ));
    } finally {
      await worker.cleanup();
    }
  });

});
