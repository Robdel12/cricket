import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  cronSchedule,
  createCricketJobs,
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import { createAppMap, formatAppMap } from '../src/app-contract.js';
import { reportJob } from '../test-support/jobs.js';
import {
  createJobLedgerTable as createPackagedJobLedgerTable,
  createCricketJobs as createPackagedCricketJobs,
  cronSchedule as packagedCronSchedule,
  defineJob as definePackagedJob,
  jobFailure as packagedJobFailure,
  redisQueue as packagedRedisQueue
} from '@robdel12/cricket/jobs';

describe('Cricket jobs: definition', () => {
  it('rejects retry policies that cannot produce safe availability dates', () => {
    assert.throws(() => retry.exponential({
      attempts: 2,
      delayMs: Number.MAX_SAFE_INTEGER
    }), /delay exceeds the supported date range/);
    assert.throws(() => retry.exponential({
      attempts: Number.MAX_SAFE_INTEGER + 1,
      delayMs: 1
    }), /attempts must be a positive safe integer/);
  });


  it('plans immutable envelopes from job input and context', async () => {
    let job = reportJob();
    let app = defineManualTestApp({});
    let worker = await startCricketWorker(app, {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      let envelope = worker.jobs.plan(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      }, {
        context: {
          requestId: 'req_123',
          source: 'report.requested',
          priority: 50
        },
        now: () => new Date('2026-06-18T12:00:00.000Z'),
        createId: () => 'jobenv_test'
      });

      assert.deepEqual(envelope, {
        schemaVersion: 2,
        id: 'jobenv_test',
        name: 'reports.generate',
        queueName: 'reports',
        idempotencyKey: 'report_123',
        priority: 50,
        input: {
          reportId: 'report_123',
          accountId: 'acct_456',
          templateId: 'template_789'
        },
        context: {
          requestId: 'req_123',
          source: 'report.requested',
          priority: 50
        },
        policy: {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delayMs: 10
          }
        },
        concurrency: [{
          type: 'partition',
          key: 'account:acct_456',
          limit: 2
        }],
        availableAt: '2026-06-18T12:00:00.000Z',
        createdAt: '2026-06-18T12:00:00.000Z'
      });
      assert.ok(Object.isFrozen(envelope));
      assert.ok(Object.isFrozen(envelope.input));
      assert.throws(() => {
        envelope.input.reportId = 'mutated';
      });
    } finally {
      await worker.cleanup();
    }
  });

  it('removes only completed and failed job records through the jobs capability', async () => {
    let job = defineJob({
      name: 'reports.cleanup',
      input: z.object({
        reportId: z.string(),
        outcome: z.enum(['completed', 'failed'])
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        if (input.outcome === 'failed')
          throw new Error('report failed');

        return { status: 'completed' };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      jobs: [job],
      queues: { test: true }
    });

    try {
      let completed = await worker.jobs.enqueue(job, {
        reportId: 'report_completed',
        outcome: 'completed'
      });
      assert.deepEqual(await worker.drain(), [{ status: 'completed' }]);

      let failed = await worker.jobs.enqueue(job, {
        reportId: 'report_failed',
        outcome: 'failed'
      });
      await assert.rejects(worker.drain(), /report failed/);

      let queued = await worker.jobs.enqueue(job, {
        reportId: 'report_queued',
        outcome: 'completed'
      });
      let result = await worker.jobs.removeFinished([
        completed.envelope.id,
        failed.envelope.id,
        queued.envelope.id,
        'jobenv_missing',
        completed.envelope.id
      ]);

      assert.deepEqual(result, {
        removed: [
          completed.envelope.id,
          failed.envelope.id
        ],
        missing: ['jobenv_missing'],
        skipped: [{
          id: queued.envelope.id,
          reason: 'not_finished'
        }]
      });
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.removed));
      assert.ok(Object.isFrozen(result.skipped));
      assert.ok(Object.isFrozen(result.skipped[0]));
      assert.deepEqual(await worker.jobs.removeFinished([completed.envelope.id]), {
        removed: [],
        missing: [completed.envelope.id],
        skipped: []
      });
      await assert.rejects(
        worker.jobs.removeFinished('jobenv_invalid'),
        /needs an array of job IDs/
      );
      await assert.rejects(
        worker.jobs.removeFinished(['']),
        /job IDs must be non-empty strings/
      );
    } finally {
      await worker.cleanup();
    }
  });

  it('fails clearly when a custom queue driver cannot remove finished jobs', async () => {
    let producer = await createCricketJobs({
      queues: {
        driver: {
          async cleanup() {}
        }
      }
    });

    try {
      assert.deepEqual(await producer.jobs.removeFinished([]), {
        removed: [],
        missing: [],
        skipped: []
      });
      await assert.rejects(
        producer.jobs.removeFinished(['jobenv_finished']),
        /does not support removing finished jobs/
      );
    } finally {
      await producer.cleanup();
    }
  });

  it('rejects queue metadata and concurrency that cannot be enforced', async () => {
    assert.throws(() => redisQueue({
      name: 'reports',
      retention: {
        completedMs: 60_000
      }
    }), /redisQueue received unknown option retention/);
    assert.throws(() => redisQueue({
      name: 'reports',
      partition: ({ input }) => input.accountId
    }), /redisQueue received unknown option partition/);
    assert.throws(() => concurrency.global({
      key: 'reports',
      limit: 0
    }), /limit must be a positive safe integer or function/);
    assert.throws(() => defineJob({
      name: 'reports.unsupportedConcurrency',
      input: z.object({}),
      concurrency: {
        type: 'custom',
        key: 'reports',
        limit: 1
      },
      run() {}
    }), /unsupported type custom/);
    assert.throws(() => defineJob({
      name: 'reports.multiplePartitions',
      input: z.object({}),
      concurrency: [
        concurrency.partition({ key: 'account', limit: 1 }),
        concurrency.partition({ key: 'region', limit: 1 })
      ],
      run() {}
    }), /accepts one partition concurrency policy/);

    let invalidPriority = defineJob({
      name: 'reports.invalidPriority',
      input: z.object({}),
      queue: redisQueue({
        name: 'reports',
        priority: () => 1.5
      }),
      run() {}
    });
    let invalidConcurrency = defineJob({
      name: 'reports.invalidConcurrency',
      input: z.object({}),
      queue: redisQueue({
        name: 'reports'
      }),
      concurrency: concurrency.partition({
        key: () => '',
        limit: 1
      }),
      run() {}
    });
    let duplicateConcurrency = defineJob({
      name: 'reports.duplicateConcurrency',
      input: z.object({}),
      queue: redisQueue({
        name: 'reports'
      }),
      concurrency: [
        concurrency.global({ key: 'reports', limit: 2 }),
        concurrency.global({ key: 'reports', limit: 1 })
      ],
      run() {}
    });

    let producer = await createCricketJobs({
      jobs: [invalidPriority, invalidConcurrency, duplicateConcurrency],
      queues: { test: true }
    });

    try {
      await assert.rejects(
        producer.jobs.enqueue(invalidPriority, {}),
        /priority must resolve to a safe integer/
      );
      await assert.rejects(
        producer.jobs.enqueue(invalidConcurrency, {}),
        /key must resolve to a non-empty string/
      );
      await assert.rejects(
        producer.jobs.enqueue(duplicateConcurrency, {}),
        /Duplicate concurrency policy global:reports/
      );
    } finally {
      await producer.cleanup();
    }
  });


  it('shows jobs in the Cricket app map', () => {
    let job = reportJob([], {
      failure: jobFailure({
        async retrying() {},
        async exhausted() {}
      })
    });
    let appMap = createAppMap(defineManualTestApp({
      jobs: [job]
    }));
    let output = formatAppMap(appMap);

    assert.equal(appMap.jobs[0].name, 'reports.generate');
    assert.match(output, /Jobs/);
    assert.match(output, /reports\.generate/);
    assert.match(output, /queue: reports/);
    assert.match(output, /state: derived/);
    assert.match(output, /failure: retrying, exhausted/);
  });

  it('shows scheduled jobs in the Cricket app map', () => {
    let job = defineJob({
      name: 'maintenance.dailyDigest',
      input: z.object({
        runDate: z.string()
      }),
      queue: redisQueue({
        name: 'maintenance'
      }),
      schedule: cronSchedule({
        key: 'daily_digest',
        cron: '15 4 * * *',
        timezone: 'America/Chicago',
        input: ({ scheduledFor }) => ({
          runDate: scheduledFor.slice(0, 10)
        })
      }),
      async run() {}
    });
    let appMap = createAppMap(defineManualTestApp({
      jobs: [job]
    }));
    let output = formatAppMap(appMap);

    assert.equal(appMap.jobs[0].schedule, 'daily_digest');
    assert.deepEqual(appMap.jobs[0].scheduleDetails, {
      key: 'daily_digest',
      cron: '15 4 * * *',
      timezone: 'America/Chicago',
      runOnStartup: false
    });
    assert.match(output, /schedule: daily_digest/);
    assert.match(output, /cron: 15 4 \* \* \*/);
    assert.match(output, /timezone: America\/Chicago/);
  });


  it('exports jobs through the package subpath', () => {
    let job = definePackagedJob({
      name: 'emails.send',
      input: z.object({
        emailId: z.string()
      }),
      queue: packagedRedisQueue({
        name: 'emails'
      }),
      async run() {
        return {
          sent: true
        };
      }
    });

    assert.equal(job.name, 'emails.send');
    assert.equal(job.queue.name, 'emails');
    assert.equal(typeof packagedJobFailure, 'function');
    assert.equal(typeof packagedCronSchedule, 'function');
    assert.equal(typeof createPackagedCricketJobs, 'function');
    assert.equal(typeof createPackagedJobLedgerTable, 'function');
  });

  it('enqueues from a producer-side Cricket jobs capability', async () => {
    let job = reportJob();
    let producer = await createCricketJobs({
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      let result = await producer.jobs.enqueue(job, {
        reportId: 'report_producer',
        accountId: 'acct_producer',
        templateId: 'template_producer'
      });
      let claim = await producer.driver.claim();

      assert.equal(result.enqueued, true);
      assert.equal(claim.envelope.name, 'reports.generate');
      assert.equal(claim.envelope.idempotencyKey, 'report_producer');
    } finally {
      await producer.cleanup();
    }
  });
});
