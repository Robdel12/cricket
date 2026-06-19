import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import knex from 'knex';

import {
  concurrency,
  createCricketJobs,
  createJobLedgerTable,
  defineCricketApp,
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  state,
  z
} from '../src/index.js';
import {
  createAppMap,
  formatAppMap
} from '../src/app-contract.js';
import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { createTestState } from '../src/test/index.js';
import {
  createJobLedgerTable as createPackagedJobLedgerTable,
  createCricketJobs as createPackagedCricketJobs,
  defineJob as definePackagedJob,
  jobFailure as packagedJobFailure,
  redisQueue as packagedRedisQueue
} from '@robdel12/cricket/jobs';

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

function createFakeRedis() {
  let strings = new Map();
  let hashes = new Map();
  let lists = new Map();
  let published = [];

  function getOrCreate(map, key, createValue) {
    if (!map.has(key))
      map.set(key, createValue());

    return map.get(key);
  }

  function list(name) {
    return getOrCreate(lists, name, () => []);
  }

  function hash(name) {
    return getOrCreate(hashes, name, () => new Map());
  }

  return {
    published,
    async set(key, value, mode) {
      if (mode === 'NX' && strings.has(key))
        return null;

      strings.set(key, value);
      return 'OK';
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async hset(key, ...fields) {
      let next = hash(key);

      for (let index = 0; index < fields.length; index += 2)
        next.set(fields[index], fields[index + 1]);

      return fields.length / 2;
    },
    async hincrby(key, field, amount) {
      let next = hash(key);
      let value = Number(next.get(field) ?? 0) + Number(amount);

      next.set(field, String(value));
      return value;
    },
    async rpush(key, value) {
      return list(key).push(value);
    },
    async lpop(key) {
      return list(key).shift() ?? null;
    },
    async blpop(key) {
      let value = list(key).shift() ?? null;

      return value ? [key, value] : null;
    },
    async del(key) {
      strings.delete(key);
      hashes.delete(key);
      lists.delete(key);
      return 1;
    },
    async publish(channel, message) {
      published.push({
        channel,
        message
      });
      return 1;
    }
  };
}

function createTestApp(testState) {
  return defineCricketApp({
    observability: {
      observe(event) {
        testState.recordEvent(event);
      }
    },
    logger: {
      info(event, metadata) {
        testState.recordLog({
          level: 'info',
          event,
          metadata
        });
      },
      warn() {},
      error() {},
      child(metadata) {
        return {
          info(event, nextMetadata = {}) {
            testState.recordLog({
              level: 'info',
              event,
              metadata: {
                ...metadata,
                ...nextMetadata
              }
            });
          },
          warn() {},
          error() {},
          child() {
            return this;
          }
        };
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
  });
}

function reportJob(events = [], options = {}) {
  return defineJob({
    name: 'reports.generate',
    input: z.object({
      reportId: z.string(),
      accountId: z.string(),
      templateId: z.string()
    }),
    context: z.object({
      requestId: z.string().optional(),
      source: z.string().optional(),
      priority: z.number().int().default(0)
    }).default({}),
    result: z.object({
      status: z.enum(['completed'])
    }),
    queue: redisQueue({
      name: 'reports',
      idempotencyKey: ({ input }) => input.reportId,
      partition: ({ input }) => `account:${input.accountId}`,
      priority: ({ context }) => context.priority
    }),
    retry: retry.exponential({
      attempts: 2,
      delayMs: 10,
      when: ({ error }) => error.retryable !== false
    }),
    ...(options.failure ? { failure: options.failure } : {}),
    concurrency: [
      concurrency.partition({
        key: ({ input }) => `account:${input.accountId}`,
        limit: 2
      })
    ],
    state: state.derived({
      from: ['accounts', 'reports', 'templates']
    }),
    async run({ input, logger, progress, services, trace }) {
      logger.info('report.started', {
        reportId: input.reportId
      });
      await progress.update({
        current: 1,
        total: 1
      });
      await trace.span('report.persist', {
        accountId: input.accountId
      }, () => services.reports.record(input));

      events.push(input.reportId);

      return {
        status: 'completed'
      };
    }
  });
}

describe('Cricket jobs', () => {
  it('plans immutable envelopes from job input and context', async () => {
    let job = reportJob();
    let app = defineCricketApp({});
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
        schemaVersion: 1,
        id: 'jobenv_test',
        name: 'reports.generate',
        queueName: 'reports',
        idempotencyKey: 'report_123',
        partition: 'account:acct_456',
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
      assert.ok(testState.jobs().some(event => event.type === 'job.completed'));
      assert.ok(testState.jobs().some(event => event.type === 'job.progressed'));
      assert.ok(testState.logs().some(log => log.event === 'report.started'));
      assert.ok(testState.events().some(event => event.type === 'trace.span.finished'));
    } finally {
      await worker.cleanup();
    }
  });

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
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_retry'
      });

      assert.deepEqual(await worker.drain(), [
        undefined,
        {
          status: 'completed'
        }
      ]);
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
        'claimed',
        'completed'
      ]);
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

  it('shows jobs in the Cricket app map', () => {
    let job = reportJob([], {
      failure: jobFailure({
        async retrying() {},
        async exhausted() {}
      })
    });
    let appMap = createAppMap(defineCricketApp({
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

  it('stores runnable envelopes in Cricket-owned Redis structures', async () => {
    let redis = createFakeRedis();
    let job = reportJob();
    let driver = await createRedisQueueDriver({
      client: redis,
      prefix: 'test:jobs',
      queueNames: ['reports']
    });
    let app = defineCricketApp({});
    let worker = await startCricketWorker(app, {
      jobs: [job],
      queues: {
        driver
      }
    });

    try {
      let input = {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      };
      let first = await worker.jobs.enqueue(job, input);
      let duplicate = await worker.jobs.enqueue(job, input);
      let claim = await driver.claim();

      assert.equal(first.enqueued, true);
      assert.equal(duplicate.duplicate, true);
      assert.equal(claim.envelope.name, 'reports.generate');
      assert.equal(claim.attempt, 1);
      assert.equal(await driver.waitForWork(), 'reports');

      await driver.progress(claim.envelope, {
        current: 1,
        total: 1
      });
      await driver.complete(claim.envelope, {
        status: 'completed'
      });

      assert.equal(redis.published.some(event => event.message === 'reports'), true);
    } finally {
      await worker.cleanup();
    }
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
    let worker = await startCricketWorker(defineCricketApp({
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
    let worker = await startCricketWorker(defineCricketApp({
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

  it('turns startup schedules into normal job envelopes', async () => {
    let ran = [];
    let job = defineJob({
      name: 'maintenance.dailyDigest',
      input: z.object({
        dryRun: z.boolean()
      }),
      queue: redisQueue({
        name: 'maintenance',
        idempotencyKey: () => 'daily_digest'
      }),
      schedule: {
        key: 'daily_digest',
        cron: '15 * * * *',
        timezone: 'UTC',
        input: () => ({
          dryRun: false
        }),
        runOnStartup: true
      },
      async run({ input }) {
        ran.push(input);
        return {
          swept: true
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.drain();

      assert.deepEqual(ran, [
        {
          dryRun: false
        }
      ]);
      assert.deepEqual(worker.driver.snapshot().schedules, [
        {
          key: 'daily_digest',
          jobName: 'maintenance.dailyDigest',
          enabled: true
        }
      ]);
    } finally {
      await worker.cleanup();
    }
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
    assert.equal(typeof createPackagedCricketJobs, 'function');
    assert.equal(typeof createPackagedJobLedgerTable, 'function');
  });
});
