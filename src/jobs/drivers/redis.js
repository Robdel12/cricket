import net from 'node:net';
import { once } from 'node:events';

import { frozenPlain } from '../../immutable.js';

function encodeCommand(parts) {
  return `*${parts.length}\r\n${parts.map(part => {
    let value = String(part);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join('')}`;
}

function parseLine(buffer, offset) {
  let end = buffer.indexOf('\r\n', offset);

  if (end === -1)
    return undefined;

  return {
    value: buffer.slice(offset, end),
    offset: end + 2
  };
}

function parseResp(buffer, offset = 0) {
  let typeByte = buffer[offset];

  if (typeByte === undefined)
    return undefined;

  let type = String.fromCharCode(typeByte);

  if (type === '+' || type === '-') {
    let line = parseLine(buffer, offset + 1);
    if (!line)
      return undefined;

    if (type === '-')
      throw new Error(line.value.toString('utf8'));

    return {
      value: line.value,
      offset: line.offset
    };
  }

  if (type === ':') {
    let line = parseLine(buffer, offset + 1);
    if (!line)
      return undefined;

    return {
      value: Number(line.value),
      offset: line.offset
    };
  }

  if (type === '$') {
    let line = parseLine(buffer, offset + 1);
    if (!line)
      return undefined;

    let length = Number(line.value);
    if (length === -1)
      return {
        value: null,
        offset: line.offset
      };

    let start = line.offset;
    let end = start + length;
    if (buffer.length < end + 2)
      return undefined;

    return {
      value: buffer.slice(start, end),
      offset: end + 2
    };
  }

  if (type === '*') {
    let line = parseLine(buffer, offset + 1);
    if (!line)
      return undefined;

    let length = Number(line.value);
    if (length === -1)
      return {
        value: null,
        offset: line.offset
      };

    let values = [];
    let nextOffset = line.offset;

    for (let index = 0; index < length; index += 1) {
      let parsed = parseResp(buffer, nextOffset);
      if (!parsed)
        return undefined;

      values.push(parsed.value);
      nextOffset = parsed.offset;
    }

    return {
      value: values,
      offset: nextOffset
    };
  }

  throw new Error(`Unsupported Redis response type ${String.fromCharCode(type)}`);
}

function decodeRedisValue(value) {
  if (Buffer.isBuffer(value))
    return value.toString('utf8');

  if (Array.isArray(value))
    return value.map(decodeRedisValue);

  return value;
}

async function createRespClient(url) {
  let parsed = new URL(url);
  let socket = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 6379)
  });
  let pending = [];
  let buffer = Buffer.alloc(0);

  function rejectPending(error) {
    while (pending.length)
      pending.shift().reject(error);
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (pending.length) {
      let response;

      try {
        response = parseResp(buffer);
      } catch (error) {
        pending.shift().reject(error);
        continue;
      }

      if (!response)
        return;

      buffer = buffer.slice(response.offset);
      pending.shift().resolve(decodeRedisValue(response.value));
    }
  });
  socket.on('error', error => rejectPending(error));
  socket.on('close', () => rejectPending(new Error('Redis connection closed')));

  await once(socket, 'connect');

  function sendCommand(...parts) {
    return new Promise((resolve, reject) => {
      pending.push({
        resolve,
        reject
      });
      socket.write(encodeCommand(parts));
    });
  }

  if (parsed.password)
    await sendCommand('AUTH', parsed.password);

  if (parsed.pathname && parsed.pathname !== '/') {
    let db = parsed.pathname.replace('/', '');
    if (db)
      await sendCommand('SELECT', db);
  }

  return {
    command: sendCommand,
    async quit() {
      socket.end();
      socket.destroy();
    }
  };
}

async function commandFor(client, name, ...args) {
  if (typeof client.command === 'function')
    return await client.command.call(client, name, ...args);

  if (typeof client.sendCommand === 'function')
    return await client.sendCommand.call(client, [name, ...args.map(String)]);

  if (typeof client.call === 'function')
    return await client.call.call(client, name, ...args);

  let method = client[name.toLowerCase()];

  if (typeof method === 'function')
    return await method.call(client, ...args);

  throw new Error('Redis client needs command, sendCommand, call, or command methods');
}

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

function queueKey(prefix, queueName) {
  return keyFor(prefix, 'queue', queueName);
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

function activeKey(prefix) {
  return keyFor(prefix, 'active');
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

async function readDuplicateEnvelope(command, duplicateKey, envelope, readEnvelope) {
  let existingId = await command('GET', duplicateKey);

  if (!existingId)
    return envelope;

  let existingEnvelope = await readEnvelope(existingId);
  return existingEnvelope ?? envelope;
}

function addQueueName(queues, queueName) {
  if (!queues.includes(queueName))
    queues.push(queueName);
}

function hashFromRedis(value) {
  if (!Array.isArray(value))
    return value ?? {};

  let hash = {};

  for (let index = 0; index < value.length; index += 2)
    hash[value[index]] = value[index + 1];

  return hash;
}

/**
 * Create a Redis-backed Cricket queue driver.
 *
 * Redis stores Cricket job coordination structures: immutable envelopes,
 * queue lists, run hashes, leases, progress streams, schedule metadata, and
 * wakeup tokens. Product records stay outside the driver.
 *
 * @param {object} [options]
 * @param {object} [options.client] - Existing Redis client-like object.
 * @param {string} [options.prefix='cricket:jobs'] - Redis key prefix.
 * @param {string[]} [options.queueNames] - Queue names to claim from.
 * @param {string} [options.url] - Redis URL used when no client is supplied.
 * @returns {Promise<object>} Redis queue driver.
 */
export async function createRedisQueueDriver({
  client,
  prefix = 'cricket:jobs',
  queueNames = [],
  url
} = {}) {
  let ownsClient = !client;
  let redis = client ?? await createRespClient(url);
  let queues = [...new Set(queueNames)];

  async function callRedis(name, ...args) {
    return await commandFor(redis, name, ...args);
  }

  async function readEnvelope(id) {
    let text = await callRedis('GET', envelopeKey(prefix, id));
    return text ? JSON.parse(text) : undefined;
  }

  async function writeEvent(type, envelope, metadata = {}) {
    let event = {
      type,
      envelopeId: envelope.id,
      jobName: envelope.name,
      queueName: envelope.queueName,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    await callRedis('RPUSH', eventsKey(prefix, envelope.id), JSON.stringify(event));
  }

  async function readList(key) {
    let values = await callRedis('LRANGE', key, '0', '-1');
    return (values ?? []).map(value => JSON.parse(value));
  }

  async function wakeWorker(envelope) {
    await callRedis('RPUSH', wakeupsKey(prefix), envelope.queueName);
    await callRedis('PUBLISH', wakeupsKey(prefix), envelope.queueName);
  }

  async function updateRunStatus(id, status, ...args) {
    await callRedis('HSET', runKey(prefix, id), 'status', status, ...args);
  }

  function isAvailable(envelope, now) {
    return new Date(envelope.availableAt ?? envelope.createdAt) <= new Date(now ?? envelope.createdAt);
  }

  return {
    async enqueue(envelope) {
      let existingEnvelope = await readEnvelope(envelope.id);

      if (existingEnvelope)
        return frozenPlain({
          enqueued: false,
          duplicate: true,
          envelope: existingEnvelope
        });

      let duplicateKey = duplicateKeyFor(prefix, envelope);

      if (duplicateKey) {
        let didSet = await callRedis('SET', duplicateKey, envelope.id, 'NX');

        if (didSet !== 'OK')
          return frozenPlain({
            enqueued: false,
            duplicate: true,
            envelope: await readDuplicateEnvelope(callRedis, duplicateKey, envelope, readEnvelope)
          });
      }

      addQueueName(queues, envelope.queueName);

      await callRedis('SET', envelopeKey(prefix, envelope.id), JSON.stringify(envelope));
      await updateRunStatus(envelope.id, isAvailable(envelope) ? 'queued' : 'delayed', 'attempts', '0');

      if (isAvailable(envelope))
        await callRedis('RPUSH', queueKey(prefix, envelope.queueName), envelope.id);
      else
        await callRedis('ZADD', delayedKey(prefix), new Date(envelope.availableAt).getTime(), envelope.id);

      await writeEvent('queued', envelope);

      if (isAvailable(envelope))
        await wakeWorker(envelope);

      return frozenPlain({
        enqueued: true,
        duplicate: false,
        envelope
      });
    },

    async claim() {
      for (let queueName of queues) {
        let id = await callRedis('LMOVE', queueKey(prefix, queueName), activeKey(prefix), 'LEFT', 'RIGHT');

        if (!id)
          continue;

        let envelope = await readEnvelope(id);
        if (!envelope) {
          await callRedis('LREM', activeKey(prefix), '0', id);
          continue;
        }

        let attempt = await callRedis('HINCRBY', runKey(prefix, id), 'attempts', '1');
        let now = new Date().toISOString();

        await callRedis('DEL', logsKey(prefix, id), spansKey(prefix, id), progressKey(prefix, id));
        await updateRunStatus(id, 'active', 'startedAt', now, 'lastHeartbeatAt', now);
        await callRedis('SET', leaseKey(prefix, id), 'active', 'EX', '60');
        await writeEvent('claimed', envelope, {
          attempt
        });

        return frozenPlain({
          envelope,
          attempt
        });
      }

      return undefined;
    },

    async progress(envelope, progress) {
      await callRedis('RPUSH', progressKey(prefix, envelope.id), JSON.stringify({
        progress,
        timestamp: new Date().toISOString()
      }));
      await writeEvent('progressed', envelope, {
        progress
      });
    },

    async complete(envelope, result) {
      let removed = await callRedis('LREM', activeKey(prefix), '0', envelope.id);

      if (!removed)
        return frozenPlain({
          settled: false
        });

      await callRedis('HSET', runKey(prefix, envelope.id), 'status', 'completed', 'result', JSON.stringify(result));
      await callRedis('DEL', leaseKey(prefix, envelope.id));
      await writeEvent('completed', envelope);
      return frozenPlain({
        settled: true
      });
    },

    async fail(envelope, error) {
      let removed = await callRedis('LREM', activeKey(prefix), '0', envelope.id);

      if (!removed)
        return frozenPlain({
          settled: false
        });

      await callRedis('HSET', runKey(prefix, envelope.id), 'status', 'failed', 'error', JSON.stringify({
        code: error?.code,
        name: error?.name,
        message: error?.message
      }));
      await callRedis('DEL', leaseKey(prefix, envelope.id));
      await writeEvent('failed', envelope);
      return frozenPlain({
        settled: true
      });
    },

    async retry(envelope) {
      let removed = await callRedis('LREM', activeKey(prefix), '0', envelope.id);

      if (!removed)
        return frozenPlain({
          settled: false
        });

      await updateRunStatus(envelope.id, 'queued');
      await callRedis('DEL', leaseKey(prefix, envelope.id));
      await callRedis('RPUSH', queueKey(prefix, envelope.queueName), envelope.id);
      await writeEvent('retry_scheduled', envelope);
      await wakeWorker(envelope);
      return frozenPlain({
        settled: true
      });
    },

    async heartbeat(envelope, {
      now = new Date()
    } = {}) {
      let timestamp = now instanceof Date ? now.toISOString() : String(now);

      await callRedis('HSET', runKey(prefix, envelope.id), 'lastHeartbeatAt', timestamp);
      await callRedis('SET', leaseKey(prefix, envelope.id), 'active', 'EX', '60');
    },

    async recordLog(envelope, log) {
      await callRedis('RPUSH', logsKey(prefix, envelope.id), JSON.stringify({
        ...log,
        timestamp: log.timestamp ?? new Date().toISOString()
      }));
    },

    async recordSpan(envelope, span) {
      await callRedis('RPUSH', spansKey(prefix, envelope.id), JSON.stringify({
        ...span,
        timestamp: span.timestamp ?? new Date().toISOString()
      }));
    },

    async recoveryCandidates() {
      let ids = await callRedis('LRANGE', activeKey(prefix), '0', '-1');
      let candidates = [];

      for (let id of ids ?? []) {
        let envelope = await readEnvelope(id);

        if (!envelope) {
          await callRedis('LREM', activeKey(prefix), '0', id);
          continue;
        }

        let run = hashFromRedis(await callRedis('HGETALL', runKey(prefix, id)));
        let leaseActive = await callRedis('GET', leaseKey(prefix, id));

        candidates.push(frozenPlain({
          envelope,
          attempt: Number(run?.attempts ?? 0),
          startedAt: run?.startedAt,
          lastHeartbeatAt: run?.lastHeartbeatAt,
          leaseActive: Boolean(leaseActive),
          logs: await readList(logsKey(prefix, id)),
          spans: await readList(spansKey(prefix, id)),
          progress: await readList(progressKey(prefix, id)),
          ledger: {
            status: run?.status,
            attempts: Number(run?.attempts ?? 0),
            startedAt: run?.startedAt,
            updatedAt: run?.lastHeartbeatAt,
            error: run?.error ? JSON.parse(run.error) : undefined
          }
        }));
      }

      return frozenPlain(candidates);
    },

    async promoteDelayed({
      now = new Date()
    } = {}) {
      let ids = await callRedis('ZRANGEBYSCORE', delayedKey(prefix), '-inf', new Date(now).getTime());
      let promoted = [];

      for (let id of ids ?? []) {
        let removed = await callRedis('ZREM', delayedKey(prefix), id);

        if (!removed)
          continue;

        let envelope = await readEnvelope(id);

        if (!envelope)
          continue;

        await updateRunStatus(envelope.id, 'queued');
        await callRedis('RPUSH', queueKey(prefix, envelope.queueName), envelope.id);
        await writeEvent('delay_promoted', envelope);
        await wakeWorker(envelope);
        promoted.push(envelope);
      }

      return frozenPlain(promoted);
    },

    async waitForWork() {
      let result = await callRedis('BLPOP', wakeupsKey(prefix), '0');

      return result?.[1] ?? undefined;
    },

    async registerSchedule(job, {
      enabled,
      lastRunAt,
      nextRunAt
    } = {}) {
      let scheduleKeyValue = scheduleKey(prefix, job.schedule.key);

      let existingText = await callRedis('GET', scheduleKeyValue);
      let existing = existingText ? JSON.parse(existingText) : {};

      await callRedis('SET', scheduleKeyValue, JSON.stringify({
        ...existing,
        key: job.schedule.key,
        jobName: job.name,
        cron: job.schedule.cron,
        timezone: job.schedule.timezone,
        enabled: enabled !== false,
        runOnStartup: job.schedule.runOnStartup === true,
        lastRunAt: existing.lastRunAt ?? lastRunAt,
        nextRunAt: nextRunAt ?? existing.nextRunAt
      }));
    },

    async scheduleState(job) {
      let text = await callRedis('GET', scheduleKey(prefix, job.schedule.key));
      return text ? frozenPlain(JSON.parse(text)) : undefined;
    },

    async updateSchedule(job, values = {}) {
      let scheduleKeyValue = scheduleKey(prefix, job.schedule.key);
      let text = await callRedis('GET', scheduleKeyValue);
      let existing = text ? JSON.parse(text) : {
        key: job.schedule.key,
        jobName: job.name
      };

      await callRedis('SET', scheduleKeyValue, JSON.stringify({
        ...existing,
        ...values
      }));
    },

    async materializeSchedule(envelope, {
      slotId
    }) {
      let slotKey = scheduleSlotKey(prefix, slotId);
      let didSet = await callRedis('SET', slotKey, envelope.id, 'NX', 'EX', '60');

      if (didSet !== 'OK') {
        let existingId = await callRedis('GET', slotKey);

        return frozenPlain({
          enqueued: false,
          duplicate: true,
          envelope: existingId ? await readEnvelope(existingId) : envelope
        });
      }

      let result = await this.enqueue(envelope);

      await callRedis('DEL', slotKey);

      return result;
    },

    async cleanup() {
      if (ownsClient)
        await redis.quit?.();
    }
  };
}
