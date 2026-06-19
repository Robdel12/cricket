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
  let type = buffer[offset];

  if (!type)
    return undefined;

  if (type === '+' || type === '-') {
    let line = parseLine(buffer, offset + 1);
    if (!line)
      return undefined;

    if (type === '-')
      throw new Error(line.value.toString('utf8'));

    return line;
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
      try {
        await sendCommand('QUIT');
      } finally {
        socket.end();
      }
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

function wakeupsKey(prefix) {
  return keyFor(prefix, 'wakeups');
}

function scheduleKey(prefix, key) {
  return keyFor(prefix, 'schedule', key);
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

/**
 * Create a Redis-backed Cricket queue driver.
 *
 * Redis stores Cricket-owned coordination structures: immutable envelopes,
 * queue lists, run hashes, leases, progress streams, schedule metadata, and
 * wakeup publications. App-owned product records stay outside the driver.
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
    await callRedis('PUBLISH', wakeupsKey(prefix), envelope.queueName);
  }

  async function updateRunStatus(id, status, ...args) {
    await callRedis('HSET', runKey(prefix, id), 'status', status, ...args);
  }

  return {
    async enqueue(envelope) {
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
      await updateRunStatus(envelope.id, 'queued', 'attempts', '0');
      await callRedis('RPUSH', queueKey(prefix, envelope.queueName), envelope.id);
      await writeEvent('queued', envelope);

      return frozenPlain({
        enqueued: true,
        duplicate: false,
        envelope
      });
    },

    async claim() {
      for (let queueName of queues) {
        let id = await callRedis('LPOP', queueKey(prefix, queueName));

        if (!id)
          continue;

        let envelope = await readEnvelope(id);
        if (!envelope)
          continue;

        let attempt = await callRedis('HINCRBY', runKey(prefix, id), 'attempts', '1');

        await updateRunStatus(id, 'active');
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
      await callRedis('RPUSH', progressKey(prefix, envelope.id), JSON.stringify(progress));
      await writeEvent('progressed', envelope, {
        progress
      });
    },

    async complete(envelope, result) {
      await callRedis('HSET', runKey(prefix, envelope.id), 'status', 'completed', 'result', JSON.stringify(result));
      await callRedis('DEL', leaseKey(prefix, envelope.id));
      await writeEvent('completed', envelope);
    },

    async fail(envelope, error) {
      await callRedis('HSET', runKey(prefix, envelope.id), 'status', 'failed', 'error', JSON.stringify({
        name: error?.name,
        message: error?.message
      }));
      await callRedis('DEL', leaseKey(prefix, envelope.id));
      await writeEvent('failed', envelope);
    },

    async retry(envelope) {
      await updateRunStatus(envelope.id, 'queued');
      await callRedis('RPUSH', queueKey(prefix, envelope.queueName), envelope.id);
      await writeEvent('retry_scheduled', envelope);
    },

    async registerSchedule(job, {
      enabled
    } = {}) {
      let scheduleKeyValue = scheduleKey(prefix, job.schedule.key);

      if (!enabled && job.schedule.removeWhenDisabled) {
        await callRedis('DEL', scheduleKeyValue);
        return;
      }

      await callRedis('SET', scheduleKeyValue, JSON.stringify({
        key: job.schedule.key,
        jobName: job.name,
        cron: job.schedule.cron,
        timezone: job.schedule.timezone,
        enabled: enabled !== false,
        runOnStartup: job.schedule.runOnStartup === true
      }));
    },

    async cleanup() {
      if (ownsClient)
        await redis.quit?.();
    }
  };
}
