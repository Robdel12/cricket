import { frozenPlain } from '../../immutable.js';
import { compareClaimOrder } from '../policy.js';
import {
  claimScript,
  enqueueScript,
  evidenceScript,
  heartbeatScript,
  progressScript,
  promoteDelayedScript,
  recoveryHeaderScript,
  registerScheduleScript,
  retryScript,
  settleScript,
  updateScheduleScript
} from './redis-scripts.js';
import { createRedisSocketClient, redisCommand } from './redis-client.js';

function keyFor(prefix, ...parts) {
  return [prefix, ...parts].join(':');
}

function envelopeKey(prefix, id) {
  return keyFor(prefix, 'envelope', id);
}

function runKey(prefix, id) {
  return keyFor(prefix, 'run', id);
}

function leaseKey(prefix, id) {
  return keyFor(prefix, 'lease', id);
}

function readyKey(prefix, queueName) {
  return keyFor(prefix, 'ready', queueName);
}

function eventsKey(prefix, id) {
  return keyFor(prefix, 'events', id);
}

function progressKey(prefix, id) {
  return keyFor(prefix, 'progress', id);
}

function logsKey(prefix, id) {
  return keyFor(prefix, 'logs', id);
}

function spansKey(prefix, id) {
  return keyFor(prefix, 'spans', id);
}

function runningKey(prefix) {
  return keyFor(prefix, 'running');
}

function wakeupsKey(prefix) {
  return keyFor(prefix, 'wakeups');
}

function scheduleKey(prefix, key) {
  return keyFor(prefix, 'schedule', key);
}

function scheduleSlotKey(prefix, slotId) {
  return keyFor(prefix, 'schedule', 'slot', slotId);
}

function delayedKey(prefix) {
  return keyFor(prefix, 'delayed');
}

function duplicateKeyFor(prefix, envelope) {
  if (!envelope.idempotencyKey)
    return undefined;

  return keyFor(prefix, 'idempotency', envelope.name, envelope.idempotencyKey);
}

function addQueueName(queues, queueName) {
  if (!queues.includes(queueName))
    queues.push(queueName);
}

function readyMember(envelope) {
  return JSON.stringify([
    envelope.createdAt,
    envelope.id
  ]);
}

function priorityScore(envelope) {
  return -(envelope.priority ?? 0);
}

/**
 * Create a Redis-backed Cricket queue driver.
 *
 * Redis stores Cricket job coordination structures: immutable envelopes,
 * ordered ready sets, running membership, run hashes, leases, progress streams,
 * schedule metadata, and wakeup tokens. Product records stay outside the driver.
 *
 * @param {object} [options]
 * @param {object} [options.client] - Existing Redis client-like object.
 * @param {string} [options.prefix='cricket:jobs'] - Redis key prefix.
 * @param {string[]} [options.queueNames] - Queue names to claim from.
 * @param {string} [options.url] - Redis URL used when no client is supplied.
 * @param {object} [options.tls] - Node TLS options for `rediss://` URLs.
 * @returns {Promise<object>} Redis queue driver.
 */
export async function createRedisQueueDriver({
  client,
  prefix = 'cricket:jobs',
  queueNames = [],
  tls: tlsOptions,
  url
} = {}) {
  let ownsClient = !client;
  let redis = client ?? await createRedisSocketClient(url, tlsOptions);
  let waitRedis;

  async function createWaitClient() {
    if (ownsClient)
      return await createRedisSocketClient(url, tlsOptions);

    if (typeof redis.duplicate !== 'function')
      throw new Error('App-provided Redis clients need duplicate() for blocking waits');

    let duplicate = await redis.duplicate();

    try {
      if (duplicate.isOpen === false && typeof duplicate.connect === 'function')
        await duplicate.connect();
    } catch (error) {
      await duplicate.quit?.();
      throw error;
    }

    return duplicate;
  }

  async function disconnectWaitClient() {
    let client = waitRedis;
    waitRedis = undefined;

    if (typeof client?.disconnect === 'function')
      await client.disconnect();
    else
      await client?.quit?.();
  }

  try {
    waitRedis = await createWaitClient();
  } catch (error) {
    if (ownsClient)
      await redis.quit?.();
    throw error;
  }

  let queues = [...new Set(queueNames)];

  async function callRedis(name, ...args) {
    return await redisCommand(redis, name, ...args);
  }

  async function callWaitRedis(name, ...args) {
    return await redisCommand(waitRedis, name, ...args);
  }

  async function readEnvelope(id) {
    let text = await callRedis('GET', envelopeKey(prefix, id));
    return text ? JSON.parse(text) : undefined;
  }

  async function readList(key) {
    let length = Number(await callRedis('LLEN', key));
    let values = [];

    for (let start = 0; start < length; start += 100) {
      let batch = await callRedis(
        'LRANGE',
        key,
        String(start),
        String(Math.min(start + 99, length - 1))
      );

      values.push(...(batch ?? []).map(value => JSON.parse(value)));
    }

    return values;
  }

  function eventFor(type, envelope, metadata = {}) {
    return {
      type,
      envelopeId: envelope.id,
      jobName: envelope.name,
      queueName: envelope.queueName,
      timestamp: new Date().toISOString(),
      ...metadata
    };
  }

  async function runScript(script, keys, args = []) {
    return await callRedis('EVAL', script, String(keys.length), ...keys, ...args.map(String));
  }

  async function runJsonScript(script, keys, args = []) {
    let value = await runScript(script, keys, args);
    return value ? JSON.parse(value) : undefined;
  }

  async function readyCandidates() {
    let candidates = new Map();

    for (let queueName of queues) {
      let key = readyKey(prefix, queueName);
      let cursor = '0';

      do {
        let result = await callRedis('ZSCAN', key, cursor, 'COUNT', '100');
        cursor = String(result?.[0] ?? '0');
        let entries = result?.[1] ?? [];
        let members = [];

        for (let index = 0; index < entries.length; index += 2)
          members.push(entries[index]);

        if (!members.length)
          continue;

        let identities = members.map(member => ({
          id: JSON.parse(member)[1],
          member
        }));
        let envelopes = await callRedis(
          'MGET',
          ...identities.map(({ id }) => envelopeKey(prefix, id))
        );

        for (let index = 0; index < identities.length; index += 1) {
          let identity = identities[index];
          let text = envelopes?.[index];

          if (!text) {
            await callRedis('ZREM', key, identity.member);
            continue;
          }

          candidates.set(identity.id, {
            envelope: JSON.parse(text),
            member: identity.member,
            readyKey: key
          });
        }
      } while (cursor !== '0');
    }

    return [...candidates.values()]
      .sort((left, right) => compareClaimOrder(left.envelope, right.envelope));
  }

  function isAvailable(envelope, now) {
    return new Date(envelope.availableAt ?? envelope.createdAt) <= new Date(now ?? envelope.createdAt);
  }

  async function enqueueEnvelope(envelope, {
    slotId
  } = {}) {
    addQueueName(queues, envelope.queueName);

    let duplicateKey = duplicateKeyFor(prefix, envelope);
    let slotKey = slotId ? scheduleSlotKey(prefix, slotId) : undefined;
    let ready = isAvailable(envelope);
    let result = await runJsonScript(enqueueScript, [
      envelopeKey(prefix, envelope.id),
      runKey(prefix, envelope.id),
      readyKey(prefix, envelope.queueName),
      delayedKey(prefix),
      eventsKey(prefix, envelope.id),
      wakeupsKey(prefix),
      duplicateKey ?? keyFor(prefix, 'unused', 'idempotency'),
      slotKey ?? keyFor(prefix, 'unused', 'schedule-slot')
    ], [
      JSON.stringify(envelope),
      envelope.id,
      prefix,
      readyMember(envelope),
      priorityScore(envelope),
      new Date(envelope.availableAt).getTime(),
      ready ? 1 : 0,
      JSON.stringify(eventFor('queued', envelope)),
      envelope.queueName,
      duplicateKey ? 1 : 0,
      slotKey ? 1 : 0
    ]);

    if (result.status === 'duplicate')
      return frozenPlain({
        enqueued: false,
        duplicate: true,
        envelope: await readEnvelope(result.id) ?? envelope
      });

    return frozenPlain({
      enqueued: true,
      duplicate: false,
      envelope
    });
  }

  return {
    async enqueue(envelope) {
      return await enqueueEnvelope(envelope);
    },

    async claim() {
      let candidates = await readyCandidates();

      for (let candidate of candidates) {
        let envelope = candidate.envelope;
        let result = await runJsonScript(claimScript, [
          runningKey(prefix),
          candidate.readyKey,
          envelopeKey(prefix, envelope.id),
          runKey(prefix, envelope.id),
          leaseKey(prefix, envelope.id),
          eventsKey(prefix, envelope.id),
          logsKey(prefix, envelope.id),
          spansKey(prefix, envelope.id),
          progressKey(prefix, envelope.id)
        ], [
          prefix,
          new Date().toISOString(),
          60,
          envelope.id,
          candidate.member
        ]);

        if (result.status !== 'claimed')
          continue;

        return frozenPlain({
          envelope: result.envelope,
          attempt: Number(result.attempt)
        });
      }

      return undefined;
    },

    async progress(envelope, progress, {
      attempt
    } = {}) {
      let progressEntry = JSON.stringify({
        progress,
        timestamp: new Date().toISOString()
      });
      let result = await runScript(progressScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        progressKey(prefix, envelope.id),
        eventsKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id)
      ], [
        envelope.id,
        attempt,
        progressEntry,
        JSON.stringify(eventFor('progressed', envelope, { progress }))
      ]);

      return frozenPlain({
        recorded: result === 1
      });
    },

    async complete(envelope, result, {
      attempt
    } = {}) {
      let duplicateKey = duplicateKeyFor(prefix, envelope);
      let settled = await runScript(settleScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id),
        eventsKey(prefix, envelope.id),
        duplicateKey ?? keyFor(prefix, 'unused', 'idempotency')
      ], [
        envelope.id,
        attempt,
        'completed',
        'result',
        JSON.stringify(result),
        JSON.stringify(eventFor('completed', envelope, { attempt })),
        duplicateKey ? 1 : 0,
        0
      ]);

      return frozenPlain({
        settled: settled === 1
      });
    },

    async fail(envelope, error, {
      attempt,
      recovering = false
    } = {}) {
      let duplicateKey = duplicateKeyFor(prefix, envelope);
      let failure = JSON.stringify({
        code: error?.code,
        name: error?.name,
        message: error?.message
      });
      let settled = await runScript(settleScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id),
        eventsKey(prefix, envelope.id),
        duplicateKey ?? keyFor(prefix, 'unused', 'idempotency')
      ], [
        envelope.id,
        attempt,
        'failed',
        'error',
        failure,
        JSON.stringify(eventFor('failed', envelope, {
          attempt,
          error: JSON.parse(failure)
        })),
        duplicateKey ? 1 : 0,
        recovering ? 1 : 0
      ]);

      return frozenPlain({
        settled: settled === 1
      });
    },

    async retry(envelope, {
      attempt,
      availableAt,
      now = new Date(),
      recovering = false
    } = {}) {
      let retryEnvelope = {
        ...envelope,
        availableAt: availableAt ?? new Date(now).toISOString()
      };
      let ready = isAvailable(retryEnvelope, now);
      let settled = await runScript(retryScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id),
        readyKey(prefix, envelope.queueName),
        delayedKey(prefix),
        eventsKey(prefix, envelope.id),
        wakeupsKey(prefix)
      ], [
        envelope.id,
        attempt,
        readyMember(envelope),
        priorityScore(envelope),
        new Date(retryEnvelope.availableAt).getTime(),
        retryEnvelope.availableAt,
        ready ? 1 : 0,
        JSON.stringify(eventFor('retry_scheduled', envelope, {
          attempt,
          availableAt: retryEnvelope.availableAt
        })),
        envelope.queueName,
        recovering ? 1 : 0
      ]);

      return frozenPlain({
        settled: settled === 1
      });
    },

    async heartbeat(envelope, {
      attempt,
      now = new Date()
    } = {}) {
      let timestamp = now instanceof Date ? now.toISOString() : String(now);
      let renewed = await runScript(heartbeatScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id)
      ], [
        envelope.id,
        attempt,
        timestamp,
        60
      ]);

      return frozenPlain({
        renewed: renewed === 1
      });
    },

    async recordLog(envelope, log, {
      attempt
    } = {}) {
      let recorded = await runScript(evidenceScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        logsKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id)
      ], [
        envelope.id,
        attempt,
        JSON.stringify({
          ...log,
          timestamp: log.timestamp ?? new Date().toISOString()
        })
      ]);

      return frozenPlain({
        recorded: recorded === 1
      });
    },

    async recordSpan(envelope, span, {
      attempt
    } = {}) {
      let recorded = await runScript(evidenceScript, [
        runningKey(prefix),
        runKey(prefix, envelope.id),
        spansKey(prefix, envelope.id),
        leaseKey(prefix, envelope.id)
      ], [
        envelope.id,
        attempt,
        JSON.stringify({
          ...span,
          timestamp: span.timestamp ?? new Date().toISOString()
        })
      ]);

      return frozenPlain({
        recorded: recorded === 1
      });
    },

    async recoveryCandidates() {
      let ids = await callRedis('SMEMBERS', runningKey(prefix));
      let candidates = [];

      for (let id of ids ?? []) {
        let keys = [
          runningKey(prefix),
          envelopeKey(prefix, id),
          runKey(prefix, id),
          leaseKey(prefix, id)
        ];
        let before = await runJsonScript(recoveryHeaderScript, keys, [id]);

        if (!before)
          continue;

        let [logs, spans, progress] = await Promise.all([
          readList(logsKey(prefix, id)),
          readList(spansKey(prefix, id)),
          readList(progressKey(prefix, id))
        ]);
        let after = await runJsonScript(recoveryHeaderScript, keys, [id]);

        if (!after || before.attempt !== after.attempt || before.status !== after.status)
          continue;

        candidates.push({
          ...after,
          logs,
          spans,
          progress
        });
      }

      return frozenPlain(candidates);
    },

    async promoteDelayed({
      now = new Date()
    } = {}) {
      let promoted = await runJsonScript(promoteDelayedScript, [
        delayedKey(prefix),
        wakeupsKey(prefix)
      ], [
        prefix,
        new Date(now).getTime(),
        new Date(now).toISOString()
      ]);

      return frozenPlain(Array.isArray(promoted) ? promoted : []);
    },

    async nextAvailableAt() {
      let result = await callRedis('ZRANGE', delayedKey(prefix), '0', '0', 'WITHSCORES');

      if (!result?.[1])
        return undefined;

      return new Date(Number(result[1])).toISOString();
    },

    async waitForWork({
      signal,
      until,
      now = new Date()
    } = {}) {
      if (signal?.aborted)
        return frozenPlain({
          reason: 'aborted'
        });

      let timeout = '0';

      if (until) {
        let remainingMs = new Date(until).getTime() - new Date(now).getTime();

        if (remainingMs <= 0)
          return frozenPlain({
            reason: 'deadline'
          });

        timeout = String(remainingMs / 1_000);
      }

      waitRedis ??= await createWaitClient();
      let work = callWaitRedis('BLPOP', wakeupsKey(prefix), timeout);
      let result;

      if (!signal) {
        result = await work;
      } else {
        result = await new Promise((resolve, reject) => {
          let aborting;
          let onAbort = () => {
            aborting = disconnectWaitClient();
            aborting.then(() => resolve(undefined), reject);
          };

          signal.addEventListener('abort', onAbort, {
            once: true
          });
          work.then(value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          }, error => {
            signal.removeEventListener('abort', onAbort);

            if (!aborting)
              reject(error);
          });
        });
      }

      if (signal?.aborted)
        return frozenPlain({
          reason: 'aborted'
        });

      if (!result)
        return frozenPlain({
          reason: 'deadline'
        });

      return frozenPlain({
        reason: 'work',
        queueName: result[1]
      });
    },

    async registerSchedule(job, {
      enabled,
      lastRunAt,
      nextRunAt
    } = {}) {
      let scheduleKeyValue = scheduleKey(prefix, job.schedule.key);
      await runScript(registerScheduleScript, [scheduleKeyValue], [JSON.stringify({
        key: job.schedule.key,
        jobName: job.name,
        cron: job.schedule.cron,
        timezone: job.schedule.timezone,
        enabled: enabled !== false,
        runOnStartup: job.schedule.runOnStartup === true,
        lastRunAt,
        nextRunAt
      })]);
    },

    async scheduleState(job) {
      let text = await callRedis('GET', scheduleKey(prefix, job.schedule.key));
      return text ? frozenPlain(JSON.parse(text)) : undefined;
    },

    async updateSchedule(job, values = {}) {
      let scheduleKeyValue = scheduleKey(prefix, job.schedule.key);
      await runScript(updateScheduleScript, [scheduleKeyValue], [JSON.stringify({
        key: job.schedule.key,
        jobName: job.name
      }), JSON.stringify(values)]);
    },

    async materializeSchedule(envelope, {
      slotId
    }) {
      return await enqueueEnvelope(envelope, { slotId });
    },

    async cleanup() {
      try {
        await disconnectWaitClient();
      } finally {
        if (ownsClient)
          await redis.quit?.();
      }
    }
  };
}
