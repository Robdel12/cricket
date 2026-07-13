import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import knex from 'knex';

import {
  createCricketJobs,
  createJobLedgerTable,
  defineJob,
  redisQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import {
  createManualClock,
  reportJob
} from '../test-support/jobs.js';

async function createLedgerDatabase({
  withLedger = true
} = {}) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-jobs-'));
  let filename = path.join(root, 'jobs.sqlite');
  let db = knex({
    client: 'sqlite3',
    connection: {
      filename
    },
    useNullAsDefault: true
  });

  try {
    if (withLedger)
      await createJobLedgerTable(db);
  } finally {
    await db.destroy();
  }

  return {
    client: 'sqlite3',
    connection: {
      filename
    },
    useNullAsDefault: true
  };
}

describe('Cricket jobs: ledger', () => {
  it('records retry availability in the job ledger', async () => {
    let time = createManualClock('2026-06-18T12:00:00.000Z');
    let attempts = 0;
    let database = await createLedgerDatabase();
    let job = defineJob({
      name: 'reports.ledgerRetry',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      retry: retry.exponential({
        attempts: 2,
        delayMs: 10
      }),
      run() {
        attempts += 1;

        if (attempts === 1)
          throw new Error('Ledger retry delay');

        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      database,
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      let queued = await worker.jobs.enqueue(job, {
        reportId: 'report_ledger_retry'
      });

      assert.deepEqual(await worker.drain(), [undefined]);

      let delayed = await worker.runtime.dependencies.db('cricket_jobs')
        .where('id', queued.envelope.id)
        .first();

      assert.equal(delayed.status, 'delayed');
      assert.equal(delayed.available_at, '2026-06-18T12:00:00.010Z');
      assert.equal(delayed.attempts, 1);

      time.advanceBy(10);
      assert.deepEqual(await worker.drain(), [{
        status: 'completed'
      }]);

      let completed = await worker.runtime.dependencies.db('cricket_jobs')
        .where('id', queued.envelope.id)
        .first();

      assert.equal(completed.status, 'completed');
      assert.equal(completed.attempts, 2);
    } finally {
      await worker.cleanup();
    }
  });



  it('keeps producer enqueue best-effort when the ledger write fails', async () => {
    let job = reportJob();
    let warnings = [];
    let db = () => ({
      async insert() {
        throw new Error('missing cricket_jobs table');
      }
    });
    let producer = await createCricketJobs({
      jobs: [job],
      ledger: {
        db
      },
      logger: {
        warn(event, metadata) {
          warnings.push({
            event,
            metadata
          });
        }
      },
      queues: {
        test: true
      }
    });

    try {
      let result = await producer.jobs.enqueue(job, {
        reportId: 'report_producer_without_ledger',
        accountId: 'acct_producer_without_ledger',
        templateId: 'template_producer_without_ledger'
      });
      let claim = await producer.driver.claim();

      assert.equal(result.enqueued, true);
      assert.equal(claim.envelope.idempotencyKey, 'report_producer_without_ledger');
      assert.ok(warnings.some(warning => warning.event === 'job.ledger_failed'));
    } finally {
      await producer.cleanup();
    }
  });

  it('records job execution in the Cricket job ledger when the app has a database', async () => {
    let database = await createLedgerDatabase();
    let job = reportJob();
    let worker = await startCricketWorker(defineManualTestApp({
      database,
      logger() {},
      services() {
        return {
          reports: {
            record(input) {
              return {
                recorded: input.reportId
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
        reportId: 'report_ledger',
        accountId: 'acct_ledger',
        templateId: 'template_ledger'
      }, {
        context: {
          requestId: 'req_ledger',
          source: 'report.requested',
          priority: 25
        }
      });
      await worker.drain();

      let rows = await worker.runtime.dependencies.db('cricket_jobs');

      assert.equal(rows.length, 1);
      assert.ok(rows[0].id.startsWith('jobenv_'));
      assert.equal(rows[0].job_name, 'reports.generate');
      assert.equal(rows[0].queue_name, 'reports');
      assert.equal(rows[0].idempotency_key, 'report_ledger');
      assert.equal(rows[0].partition_key, 'account:acct_ledger');
      assert.equal(rows[0].request_id, 'req_ledger');
      assert.equal(rows[0].source, 'report.requested');
      assert.equal(rows[0].priority, 25);
      assert.equal(rows[0].available_at, rows[0].created_at);
      assert.equal(rows[0].status, 'completed');
      assert.equal(rows[0].attempts, 1);
      assert.deepEqual(JSON.parse(rows[0].input), {
        reportId: 'report_ledger',
        accountId: 'acct_ledger',
        templateId: 'template_ledger'
      });
      assert.deepEqual(JSON.parse(rows[0].latest_progress), {
        current: 1,
        total: 1
      });
      assert.deepEqual(JSON.parse(rows[0].result), {
        status: 'completed'
      });
      assert.ok(rows[0].job_run_id.startsWith('jobrun_'));
      assert.ok(rows[0].created_at);
      assert.ok(rows[0].queued_at);
      assert.ok(rows[0].started_at);
      assert.ok(rows[0].finished_at);
    } finally {
      await worker.cleanup();
    }
  });

  it('keeps job execution correct when ledger writes fail', async () => {
    let warnings = [];
    let database = await createLedgerDatabase({
      withLedger: false
    });
    let job = reportJob();
    let worker = await startCricketWorker(defineManualTestApp({
      database,
      logger: {
        info() {},
        error() {},
        warn(event, metadata) {
          warnings.push({
            event,
            metadata
          });
        },
        child() {
          return this;
        }
      },
      services() {
        return {
          reports: {
            record(input) {
              return {
                recorded: input.reportId
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
        reportId: 'report_without_ledger',
        accountId: 'acct_without_ledger',
        templateId: 'template_without_ledger'
      });

      assert.deepEqual(await worker.drain(), [
        {
          status: 'completed'
        }
      ]);
      assert.ok(warnings.some(warning => warning.event === 'job.ledger_failed'));
    } finally {
      await worker.cleanup();
    }
  });

});
