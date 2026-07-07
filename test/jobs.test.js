import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import knex from 'knex';

import {
  concurrency,
  cronSchedule,
  createCricketJobs,
  createJobLedgerTable,
  defineCricketApp,
  defineJob,
  jobFailure,
  redisQueue,
  planCronSchedule,
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
import { previousCronRun } from '../src/jobs/schedule.js';
import { createTestState } from '../src/test/index.js';
import {
  createJobLedgerTable as createPackagedJobLedgerTable,
  createCricketJobs as createPackagedCricketJobs,
  cronSchedule as packagedCronSchedule,
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
  let sortedSets = new Map();
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

  function sortedSet(name) {
    return getOrCreate(sortedSets, name, () => new Map());
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
    async hgetall(key) {
      return Object.fromEntries(hash(key).entries());
    },
    async rpush(key, value) {
      return list(key).push(value);
    },
    async lrange(key, start, stop) {
      let items = list(key);
      let from = Number(start);
      let to = Number(stop);

      return items.slice(from, to === -1 ? undefined : to + 1);
    },
    async lmove(source, destination, sourceSide, destinationSide) {
      let sourceList = list(source);
      let value = sourceSide === 'RIGHT'
        ? sourceList.pop()
        : sourceList.shift();

      if (value === undefined)
        return null;

      if (destinationSide === 'LEFT')
        list(destination).unshift(value);
      else
        list(destination).push(value);

      return value;
    },
    async lrem(key, count, value) {
      let items = list(key);
      let removed = 0;

      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index] !== value)
          continue;

        items.splice(index, 1);
        removed += 1;

        if (Number(count) !== 0 && removed >= Number(count))
          break;
      }

      return removed;
    },
    async zadd(key, score, value) {
      sortedSet(key).set(value, Number(score));
      return 1;
    },
    async zrangebyscore(key, min, max) {
      let minScore = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
      let maxScore = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);

      return [...sortedSet(key).entries()]
        .filter(([, score]) => score >= minScore && score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .map(([value]) => value);
    },
    async zrem(key, value) {
      return sortedSet(key).delete(value) ? 1 : 0;
    },
    async lpop(key) {
      return list(key).shift() ?? null;
    },
    async blpop(key) {
      let value = list(key).shift() ?? null;

      return value ? [key, value] : null;
    },
    async del(...keys) {
      let deleted = 0;

      for (let key of keys) {
        deleted += strings.delete(key) ? 1 : 0;
        deleted += hashes.delete(key) ? 1 : 0;
        deleted += lists.delete(key) ? 1 : 0;
        deleted += sortedSets.delete(key) ? 1 : 0;
      }

      return deleted;
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

function encodeRespSimpleString(value) {
  return `+${value}\r\n`;
}

function encodeRespInteger(value) {
  return `:${value}\r\n`;
}

function encodeRespBulkString(value) {
  if (value === null || value === undefined)
    return '$-1\r\n';

  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function parseRespCommand(buffer) {
  if (!buffer.startsWith('*'))
    throw new Error('Expected Redis array command');

  let lineEnd = buffer.indexOf('\r\n');
  if (lineEnd === -1)
    return undefined;

  let count = Number(buffer.slice(1, lineEnd));
  let offset = lineEnd + 2;
  let parts = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== '$')
      throw new Error('Expected Redis bulk command part');

    let lengthEnd = buffer.indexOf('\r\n', offset);
    if (lengthEnd === -1)
      return undefined;

    let length = Number(buffer.slice(offset + 1, lengthEnd));
    let start = lengthEnd + 2;
    let end = start + length;

    if (buffer.length < end + 2)
      return undefined;

    parts.push(buffer.slice(start, end));
    offset = end + 2;
  }

  return {
    parts,
    rest: buffer.slice(offset)
  };
}

async function createRespRedisServer(handleCommand) {
  let commands = [];
  let sockets = new Set();
  let server = net.createServer(socket => {
    let buffer = '';

    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');

      while (buffer) {
        let parsed = parseRespCommand(buffer);

        if (!parsed)
          return;

        let command = parsed.parts.map(part => part.toString('utf8'));
        commands.push(command);
        socket.write(handleCommand(command));
        buffer = parsed.rest;
      }
    });
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  let address = server.address();

  return {
    commands,
    url: `redis://127.0.0.1:${address.port}`,
    async close() {
      for (let socket of sockets)
        socket.destroy();

      await new Promise(resolve => server.close(resolve));
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

  it('recovers an active claimed job by retrying from normal job signals', async () => {
    let processed = [];
    let productEvents = [];
    let testState = createTestState();
    let job = defineJob({
      name: 'reports.recover',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      failure: jobFailure({
        async retrying({ input, failure }) {
          productEvents.push({
            reportId: input.reportId,
            reason: failure.code
          });
        }
      }),
      recover({
        logs
      }) {
        if (!logs.seen('report.started', {
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'report_never_started',
              message: 'report job was claimed but never started'
            }
          };

        return {
          action: 'continue'
        };
      },
      async run({
        input,
        logger
      }) {
        logger.info('report.started', {
          reportId: input.reportId
        });
        processed.push(input.reportId);

        return {
          status: 'completed'
        };
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
        reportId: 'report_recovered'
      });

      let interrupted = await worker.driver.claim();

      assert.equal(interrupted.envelope.name, 'reports.recover');

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'retry');
      assert.equal(recovery[0].decision.reason.code, 'report_never_started');
      assert.ok(testState.jobs().some(event =>
        event.type === 'job.recovery.decided' &&
        event.decision.action === 'retry'
      ));
      assert.ok(testState.jobs().some(event => event.type === 'job.retry_scheduled'));

      assert.deepEqual(await worker.drain(), [
        {
          status: 'completed'
        }
      ]);
      assert.deepEqual(processed, ['report_recovered']);
      assert.deepEqual(productEvents, [
        {
          reportId: 'report_recovered',
          reason: 'report_never_started'
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('keeps an active job running when recovery sees fresh logs and progress', async () => {
    let testState = createTestState();
    let releaseJob;
    let started = new Promise(resolve => {
      releaseJob = resolve;
    });
    let finishJob;
    let finished = new Promise(resolve => {
      finishJob = resolve;
    });
    let decisions = [];
    let job = defineJob({
      name: 'reports.long',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        logs,
        progress,
        run
      }) {
        decisions.push({
          heartbeat: Boolean(run.lastHeartbeatAt),
          logSeen: logs.seen('report.started', {
            within: '5 minutes'
          }),
          progressSeen: progress.seen({
            within: '5 minutes'
          })
        });

        if (!logs.seen('report.started', {
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'missing_report_log'
            }
          };

        if (!progress.seen({
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'missing_report_progress'
            }
          };

        return {
          action: 'continue'
        };
      },
      async run({
        logger,
        progress
      }) {
        logger.info('report.started');
        await progress.update({
          phase: 'waiting'
        });
        releaseJob();
        await finished;

        return {
          status: 'completed'
        };
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
        reportId: 'report_long'
      });

      let drain = worker.drain();

      await started;

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'continue');
      assert.deepEqual(decisions, [
        {
          heartbeat: true,
          logSeen: true,
          progressSeen: true
        }
      ]);

      finishJob();

      assert.deepEqual(await drain, [
        {
          status: 'completed'
        }
      ]);
    } finally {
      finishJob();
      await worker.cleanup();
    }
  });

  it('records normal logs and spans emitted by recovery', async () => {
    let recoveries = [];
    let job = defineJob({
      name: 'reports.recoverySignals',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async recover({
        logs,
        spans,
        logger,
        trace
      }) {
        recoveries.push({
          logSeen: logs.seen('recovery.checked'),
          spanSeen: spans.seen('recovery.inspect')
        });

        logger.info('recovery.checked');
        await trace.span('recovery.inspect', {}, () => undefined);

        return {
          action: 'continue'
        };
      },
      async run() {
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_recovery_signals'
      });

      await worker.driver.claim();
      await worker.recover();
      await worker.recover();

      assert.deepEqual(recoveries, [
        {
          logSeen: false,
          spanSeen: false
        },
        {
          logSeen: true,
          spanSeen: true
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('does not let a late completion overwrite a recovery retry', async () => {
    let testState = createTestState();
    let releaseFirstRun;
    let firstRunStarted = new Promise(resolve => {
      releaseFirstRun = resolve;
    });
    let finishFirstRun;
    let firstRunFinished = new Promise(resolve => {
      finishFirstRun = resolve;
    });
    let runs = [];
    let job = defineJob({
      name: 'reports.lateComplete',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover() {
        return {
          action: 'retry',
          reason: {
            code: 'claimed_worker_lost'
          }
        };
      },
      async run({
        input
      }) {
        runs.push(input.reportId);

        if (runs.length === 1) {
          releaseFirstRun();
          await firstRunFinished;
        }

        return {
          status: 'completed',
          attempt: runs.length
        };
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
        reportId: 'report_late_complete'
      });

      let firstDrain = worker.drain();

      await firstRunStarted;

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'retry');

      finishFirstRun();

      assert.deepEqual(await firstDrain, [
        undefined,
        {
          status: 'completed',
          attempt: 2
        }
      ]);
      assert.deepEqual(runs, ['report_late_complete', 'report_late_complete']);
      assert.equal(testState.jobs().filter(event => event.type === 'job.completed').length, 1);
    } finally {
      finishFirstRun();
      await worker.cleanup();
    }
  });

  it('clears recovery evidence when retrying into a new active attempt', async () => {
    let recoveries = [];
    let job = defineJob({
      name: 'reports.retryFreshEvidence',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        logs,
        progress
      }) {
        recoveries.push({
          logSeen: logs.seen('report.started'),
          progressSeen: progress.seen({
            within: '5 minutes'
          })
        });

        return {
          action: 'retry',
          reason: {
            code: 'force_retry'
          }
        };
      },
      async run() {
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_retry_fresh_evidence'
      });

      let firstAttempt = await worker.driver.claim();

      await worker.driver.recordLog(firstAttempt.envelope, {
        level: 'info',
        event: 'report.started'
      });
      await worker.driver.progress(firstAttempt.envelope, {
        phase: 'first'
      });
      await worker.recover();

      let secondAttempt = await worker.driver.claim();

      assert.equal(secondAttempt.attempt, 2);

      await worker.recover();

      assert.deepEqual(recoveries, [
        {
          logSeen: true,
          progressSeen: true
        },
        {
          logSeen: false,
          progressSeen: false
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('recovers Redis-claimed jobs from the active list', async () => {
    let processed = [];
    let redis = createFakeRedis();
    let driver = await createRedisQueueDriver({
      client: redis,
      prefix: 'recover:jobs',
      queueNames: ['reports']
    });
    let job = defineJob({
      name: 'reports.redisRecover',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        run,
        logs
      }) {
        if (run.lastHeartbeatAt && !logs.seen('report.started', {
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'redis_claim_interrupted'
            }
          };

        return {
          action: 'continue'
        };
      },
      async run({
        input,
        logger
      }) {
        logger.info('report.started', {
          reportId: input.reportId
        });
        processed.push(input.reportId);

        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        driver
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_redis_recovered'
      });

      let interrupted = await driver.claim();

      assert.equal(interrupted.envelope.name, 'reports.redisRecover');
      assert.equal((await driver.recoveryCandidates()).length, 1);

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'retry');
      assert.equal(recovery[0].decision.reason.code, 'redis_claim_interrupted');

      assert.deepEqual(await worker.recover(), []);

      assert.deepEqual(await worker.drain(), [
        {
          status: 'completed'
        }
      ]);
      assert.deepEqual(processed, ['report_redis_recovered']);
    } finally {
      await worker.cleanup();
    }
  });

  it('clears Redis recovery evidence between attempts', async () => {
    let recoveries = [];
    let redis = createFakeRedis();
    let driver = await createRedisQueueDriver({
      client: redis,
      prefix: 'recover:fresh',
      queueNames: ['reports']
    });
    let job = defineJob({
      name: 'reports.redisFreshEvidence',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        logs,
        progress
      }) {
        recoveries.push({
          logSeen: logs.seen('report.started'),
          progressSeen: progress.seen({
            within: '5 minutes'
          })
        });

        return {
          action: 'retry',
          reason: {
            code: 'force_retry'
          }
        };
      },
      async run() {
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        driver
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_redis_fresh_evidence'
      });

      let firstAttempt = await driver.claim();

      await driver.recordLog(firstAttempt.envelope, {
        level: 'info',
        event: 'report.started'
      });
      await driver.progress(firstAttempt.envelope, {
        phase: 'first'
      });
      await worker.recover();

      let secondAttempt = await driver.claim();

      assert.equal(secondAttempt.attempt, 2);

      await worker.recover();

      assert.deepEqual(recoveries, [
        {
          logSeen: true,
          progressSeen: true
        },
        {
          logSeen: false,
          progressSeen: false
        }
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
    let appMap = createAppMap(defineCricketApp({
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

  it('stores runnable envelopes in Redis coordination structures', async () => {
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

  it('accepts Redis simple string responses from the socket driver', async () => {
    let redis = await createRespRedisServer(([command]) => {
      if (command === 'GET')
        return encodeRespBulkString(null);

      if (command === 'SET')
        return encodeRespSimpleString('OK');

      if (['HSET', 'RPUSH', 'PUBLISH'].includes(command))
        return encodeRespInteger(1);

      return encodeRespSimpleString('OK');
    });
    let driver = await createRedisQueueDriver({
      url: redis.url,
      prefix: 'resp:jobs',
      queueNames: ['reports']
    });
    let envelope = {
      schemaVersion: 1,
      id: 'jobenv_resp_simple_string',
      name: 'reports.generate',
      queueName: 'reports',
      input: {
        reportId: 'report_resp',
        accountId: 'acct_resp',
        templateId: 'template_resp'
      },
      context: {},
      attempts: 1,
      createdAt: '2026-05-15T12:00:00.000Z',
      availableAt: '2026-05-15T12:00:00.000Z'
    };

    try {
      let result = await driver.enqueue(envelope);

      assert.equal(result.enqueued, true);
      assert.deepEqual(redis.commands.map(command => command[0]), [
        'GET',
        'SET',
        'HSET',
        'RPUSH',
        'RPUSH',
        'RPUSH',
        'PUBLISH'
      ]);
    } finally {
      await driver.cleanup();
      await redis.close();
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

  it('plans cron due slots with a fixed clock', () => {
    let schedule = cronSchedule({
      key: 'daily_digest',
      cron: '15 4 * * *',
      timezone: 'America/Chicago',
      input: ({ scheduledFor }) => ({
        runDate: scheduledFor.slice(0, 10)
      })
    });
    let plan = planCronSchedule(schedule, {
      lastRunAt: '2026-06-18T09:15:00.000Z',
      now: new Date('2026-06-19T09:16:00.000Z')
    });

    assert.deepEqual(plan.due, [
      {
        slotId: 'daily_digest:2026-06-19T09:15:00.000Z',
        scheduleKey: 'daily_digest',
        scheduledFor: '2026-06-19T09:15:00.000Z'
      }
    ]);
    assert.equal(plan.nextRunAt, '2026-06-20T09:15:00.000Z');
  });

  it('plans the current cron slot when the clock is exactly on the boundary', () => {
    let schedule = cronSchedule({
      key: 'daily_digest',
      cron: '15 4 * * *',
      timezone: 'America/Chicago',
      input: ({ scheduledFor }) => ({
        runDate: scheduledFor.slice(0, 10)
      })
    });
    let workerStart = new Date('2026-06-19T09:15:00.000Z');
    let plan = planCronSchedule(schedule, {
      lastRunAt: previousCronRun(schedule, workerStart),
      now: workerStart
    });

    assert.deepEqual(plan.due, [
      {
        slotId: 'daily_digest:2026-06-19T09:15:00.000Z',
        scheduleKey: 'daily_digest',
        scheduledFor: '2026-06-19T09:15:00.000Z'
      }
    ]);
  });

  it('keeps delayed jobs out of the ready queue until they are available', async () => {
    let now = new Date('2026-06-19T12:00:00.000Z');
    let job = reportJob();
    let worker = await startCricketWorker(createTestApp(createTestState()), {
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

  it('materializes and runs cron schedules through the worker boundary', async () => {
    let ran = [];
    let testState = createTestState();
    let now = new Date('2026-06-19T09:14:00.000Z');
    let job = defineJob({
      name: 'maintenance.dailyDigest',
      input: z.object({
        runDate: z.string()
      }),
      queue: redisQueue({
        name: 'maintenance',
        idempotencyKey: ({ input }) => `daily_digest:${input.runDate}`
      }),
      schedule: cronSchedule({
        key: 'daily_digest',
        cron: '15 4 * * *',
        timezone: 'America/Chicago',
        input: ({ scheduledFor }) => ({
          runDate: scheduledFor.slice(0, 10)
        })
      }),
      async run({ input }) {
        ran.push(input);
        return {
          swept: true
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      clock: {
        now: () => now
      },
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.schedules.tick();
      assert.deepEqual(await worker.drain(), []);

      now = new Date('2026-06-19T09:16:00.000Z');
      let materialized = await worker.schedules.tick();

      assert.equal(materialized[0].enqueued, true);
      assert.deepEqual(await worker.drain(), [
        {
          swept: true
        }
      ]);
      assert.deepEqual(ran, [
        {
          runDate: '2026-06-19'
        }
      ]);
      assert.ok(testState.jobs().some(event =>
        event.type === 'job.completed' &&
        event.jobName === 'maintenance.dailyDigest' &&
        event.scheduleKey === 'daily_digest' &&
        event.scheduledFor === '2026-06-19T09:15:00.000Z'
      ));
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
      schedule: cronSchedule({
        key: 'daily_digest',
        cron: '15 * * * *',
        timezone: 'UTC',
        input: () => ({
          dryRun: false
        }),
        runOnStartup: true
      }),
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
    assert.equal(typeof packagedCronSchedule, 'function');
    assert.equal(typeof createPackagedCricketJobs, 'function');
    assert.equal(typeof createPackagedJobLedgerTable, 'function');
  });
});
