import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  defineCricketApp,
  defineJob,
  redisQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { createTestState } from '../src/test/index.js';
import {
  createManualClock,
  createTestApp,
  reportJob
} from '../test-support/jobs.js';

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
    async zrange(key, start, stop, withScores) {
      let values = [...sortedSet(key).entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(Number(start), Number(stop) + 1);

      if (String(withScores).toUpperCase() === 'WITHSCORES')
        return values.flatMap(([value, score]) => [value, String(score)]);

      return values.map(([value]) => value);
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


describe('Cricket jobs: redis', () => {
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
      assert.deepEqual(await driver.waitForWork(), {
        reason: 'work',
        queueName: 'reports'
      });

      await driver.progress(claim.envelope, {
        current: 1,
        total: 1
      });
      await driver.complete(claim.envelope, {
        status: 'completed'
      });

      let afterCompletion = await worker.jobs.enqueue(job, input);
      let secondClaim = await driver.claim();

      await driver.fail(secondClaim.envelope, new Error('terminal failure'));

      let afterFailure = await worker.jobs.enqueue(job, input);

      assert.equal(redis.published.some(event => event.message === 'reports'), true);
      assert.equal(afterCompletion.enqueued, true);
      assert.equal(afterFailure.enqueued, true);
    } finally {
      await worker.cleanup();
    }
  });

  it('claims Redis work by priority with deterministic ties', async () => {
    let redis = createFakeRedis();
    let driver = await createRedisQueueDriver({
      client: redis,
      prefix: 'priority:jobs',
      queueNames: ['reports']
    });
    let job = defineJob({
      name: 'reports.redisPriority',
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
      run() {}
    });
    let worker = await startCricketWorker(defineCricketApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });
    let now = () => new Date('2026-06-18T12:00:00.000Z');

    try {
      await worker.jobs.enqueue(job, { reportId: 'low' }, {
        context: { priority: 1 },
        createId: () => 'jobenv_redis_low',
        now
      });
      await worker.jobs.enqueue(job, { reportId: 'high_b' }, {
        context: { priority: 10 },
        createId: () => 'jobenv_redis_high_b',
        now
      });
      await worker.jobs.enqueue(job, { reportId: 'high_a' }, {
        context: { priority: 10 },
        createId: () => 'jobenv_redis_high_a',
        now
      });

      let first = await driver.claim();
      assert.equal(first.envelope.input.reportId, 'high_a');
      await driver.complete(first.envelope, {});

      let second = await driver.claim();
      assert.equal(second.envelope.input.reportId, 'high_b');
      await driver.complete(second.envelope, {});

      let third = await driver.claim();
      assert.equal(third.envelope.input.reportId, 'low');
    } finally {
      await worker.cleanup();
    }
  });

  it('enforces shared Redis partition capacity across driver instances', async () => {
    let redis = createFakeRedis();
    let driverA = await createRedisQueueDriver({
      client: redis,
      prefix: 'concurrency:jobs',
      queueNames: ['reports']
    });
    let driverB = await createRedisQueueDriver({
      client: redis,
      prefix: 'concurrency:jobs',
      queueNames: ['reports']
    });
    let job = defineJob({
      name: 'reports.redisConcurrency',
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
      run() {}
    });
    let workerA = await startCricketWorker(defineCricketApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: driverA }
    });
    let workerB = await startCricketWorker(defineCricketApp({ logger() {} }), {
      jobs: [job],
      queues: { driver: driverB }
    });

    try {
      await workerA.jobs.enqueue(job, {
        reportId: 'account_a_1',
        accountId: 'a'
      }, { createId: () => 'jobenv_redis_partition_1' });
      await workerA.jobs.enqueue(job, {
        reportId: 'account_a_2',
        accountId: 'a'
      }, { createId: () => 'jobenv_redis_partition_2' });
      await workerA.jobs.enqueue(job, {
        reportId: 'account_b_1',
        accountId: 'b'
      }, { createId: () => 'jobenv_redis_partition_3' });

      let accountA = await driverA.claim();
      let accountB = await driverB.claim();

      assert.equal(accountA.envelope.input.reportId, 'account_a_1');
      assert.equal(accountB.envelope.input.reportId, 'account_b_1');

      await driverA.complete(accountA.envelope, {});

      let nextAccountA = await driverB.claim();
      assert.equal(nextAccountA.envelope.input.reportId, 'account_a_2');
    } finally {
      await workerA.cleanup();
      await workerB.cleanup();
    }
  });

  it('keeps Redis retries delayed until their calculated availability', async () => {
    let time = createManualClock('2026-06-18T12:00:00.000Z');
    let attempts = 0;
    let redis = createFakeRedis();
    let driver = await createRedisQueueDriver({
      client: redis,
      prefix: 'retry:jobs',
      queueNames: ['reports']
    });
    let job = defineJob({
      name: 'reports.redisRetry',
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
          throw new Error('Redis retry delay');

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
        reportId: 'report_redis_retry'
      });

      assert.deepEqual(await worker.drain(), [undefined]);
      assert.equal(await driver.nextAvailableAt(), '2026-06-18T12:00:00.010Z');
      assert.equal(await driver.claim(), undefined);

      time.advanceBy(10);
      assert.deepEqual(await worker.drain(), [{
        status: 'completed'
      }]);
      assert.equal(attempts, 2);
    } finally {
      await worker.cleanup();
    }
  });


});
