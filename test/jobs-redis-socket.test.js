import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import nodeTls from 'node:tls';

import { createRedisSocketClient } from '../src/jobs/drivers/redis-client.js';
import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { deferred } from '../test-support/jobs.js';

function encodeRespSimpleString(value) {
  return `+${value}\r\n`;
}

function encodeRespError(value) {
  return `-${value}\r\n`;
}

function encodeRespBulkString(value) {
  if (value === null || value === undefined)
    return '$-1\r\n';

  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function encodeRespArray(values) {
  return `*${values.length}\r\n${values.map(encodeRespBulkString).join('')}`;
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

async function createRespRedisServer(handleCommand, {
  tls
} = {}) {
  let commands = [];
  let sockets = new Set();
  let closeWaiters = new Set();
  let nextConnectionId = 1;
  function handleSocket(socket) {
    let buffer = '';
    let connectionId = nextConnectionId;

    nextConnectionId += 1;

    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);

      if (!sockets.size) {
        for (let resolve of closeWaiters)
          resolve();

        closeWaiters.clear();
      }
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');

      while (buffer) {
        let parsed = parseRespCommand(buffer);

        if (!parsed)
          return;

        let command = parsed.parts.map(part => part.toString('utf8'));
        commands.push(command);
        let response = handleCommand(command, {
          connectionId
        });

        if (response !== undefined)
          socket.write(response);
        buffer = parsed.rest;
      }
    });
  }
  let server = tls
    ? nodeTls.createServer(tls, handleSocket)
    : net.createServer(handleSocket);

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  let address = server.address();

  return {
    commands,
    url: `${tls ? 'rediss' : 'redis'}://127.0.0.1:${address.port}`,
    async waitForNoConnections() {
      if (!sockets.size)
        return;

      await new Promise(resolve => closeWaiters.add(resolve));
    },
    async close() {
      for (let socket of sockets)
        socket.destroy();

      await new Promise(resolve => server.close(resolve));
    }
  };
}

describe('Cricket jobs: Redis socket', () => {
  it('decodes atomic Lua results from the socket driver', async () => {
    let redis = await createRespRedisServer(([command]) => {
      if (command === 'EVAL')
        return encodeRespBulkString(JSON.stringify({
          status: 'enqueued',
          id: 'jobenv_resp_script'
        }));

      throw new Error(`Unexpected Redis command ${command}`);
    });
    let driver = await createRedisQueueDriver({
      url: redis.url,
      prefix: 'resp:jobs',
      queueNames: ['reports']
    });
    let envelope = {
      schemaVersion: 1,
      id: 'jobenv_resp_script',
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
      assert.deepEqual(redis.commands.map(command => command[0]), ['EVAL']);
    } finally {
      await driver.cleanup();
      await redis.close();
    }
  });

  it('keeps Redis commands usable while the worker blocks for a wakeup', async () => {
    let blocked = deferred();
    let blockingConnection;
    let blockingCalls = 0;
    let commandConnections = [];
    let redis = await createRespRedisServer(([command], {
      connectionId
    }) => {
      if (command === 'BLPOP') {
        blockingCalls += 1;

        if (blockingCalls > 1)
          return encodeRespArray(['blocking:jobs:wakeups', 'reports']);

        blockingConnection = connectionId;
        blocked.resolve();
        return undefined;
      }

      commandConnections.push(connectionId);

      if (command === 'EVAL')
        return encodeRespBulkString(JSON.stringify({
          status: 'enqueued',
          id: 'jobenv_blocking_connection'
        }));

      return encodeRespSimpleString('OK');
    });
    let driver = await createRedisQueueDriver({
      url: redis.url,
      prefix: 'blocking:jobs',
      queueNames: ['reports']
    });
    let controller = new AbortController();
    let envelope = {
      schemaVersion: 1,
      id: 'jobenv_blocking_connection',
      name: 'reports.generate',
      queueName: 'reports',
      input: {
        reportId: 'report_blocking_connection'
      },
      context: {},
      policy: {
        attempts: 1
      },
      createdAt: '2026-06-18T12:00:00.000Z',
      availableAt: '2026-06-18T12:00:00.000Z'
    };

    try {
      let waiting = driver.waitForWork({
        signal: controller.signal
      });

      await blocked.promise;
      assert.equal((await driver.enqueue(envelope)).enqueued, true);
      assert.ok(commandConnections.every(connectionId => connectionId !== blockingConnection));

      controller.abort();
      assert.deepEqual(await waiting, {
        reason: 'aborted'
      });
      assert.deepEqual(await driver.waitForWork(), {
        reason: 'work',
        queueName: 'reports'
      });
    } finally {
      controller.abort();
      await driver.cleanup();
      await redis.waitForNoConnections();
      await redis.close();
    }
  });

  it('authenticates ACL URLs and selects their database', async () => {
    let redis = await createRespRedisServer(([command]) => {
      if (command === 'AUTH' || command === 'SELECT')
        return encodeRespSimpleString('OK');

      throw new Error(`Unexpected Redis command ${command}`);
    });
    let url = redis.url.replace('redis://', 'redis://worker:secret@') + '/2';
    let driver = await createRedisQueueDriver({ url });

    try {
      assert.deepEqual(redis.commands, [
        ['AUTH', 'worker', 'secret'],
        ['SELECT', '2'],
        ['AUTH', 'worker', 'secret'],
        ['SELECT', '2']
      ]);
    } finally {
      await driver.cleanup();
      await redis.close();
    }
  });

  it('keeps the socket synchronized after a Redis command error', async () => {
    let redis = await createRespRedisServer(([command]) => {
      if (command === 'FAIL')
        return encodeRespError('ERR expected failure');

      if (command === 'PING')
        return encodeRespSimpleString('PONG');

      throw new Error(`Unexpected Redis command ${command}`);
    });
    let client = await createRedisSocketClient(redis.url);

    try {
      await assert.rejects(client.command('FAIL'), /expected failure/);
      assert.equal(await client.command('PING'), 'PONG');
    } finally {
      await client.quit();
      await redis.close();
    }
  });

  it('connects to rediss URLs with explicit trust options', async () => {
    let certificate = fs.readFileSync(new URL('./fixtures/redis-cert.pem', import.meta.url));
    let key = fs.readFileSync(new URL('./fixtures/redis-key.pem', import.meta.url));
    let redis = await createRespRedisServer(([command]) => {
      if (command === 'EVAL')
        return encodeRespBulkString(JSON.stringify({
          status: 'enqueued',
          id: 'jobenv_tls'
        }));

      throw new Error(`Unexpected Redis command ${command}`);
    }, {
      tls: {
        cert: certificate,
        key
      }
    });
    let driver;
    let envelope = {
      schemaVersion: 2,
      id: 'jobenv_tls',
      name: 'reports.generate',
      queueName: 'reports',
      input: {},
      context: {},
      policy: { attempts: 1 },
      createdAt: '2026-07-10T05:00:00.000Z',
      availableAt: '2026-07-10T05:00:00.000Z'
    };

    try {
      driver = await createRedisQueueDriver({
        url: redis.url,
        tls: {
          ca: certificate
        }
      });
      assert.equal((await driver.enqueue(envelope)).enqueued, true);
      assert.deepEqual(redis.commands.map(command => command[0]), ['EVAL']);
    } finally {
      await driver?.cleanup();
      await redis.close();
    }
  });

  it('rejects unsupported URLs before opening a Redis connection', async () => {
    await assert.rejects(
      createRedisQueueDriver({ url: 'http://127.0.0.1:6379' }),
      /must use redis:\/\/ or rediss:\/\//
    );
    await assert.rejects(
      createRedisQueueDriver({ url: 'redis://worker@127.0.0.1:6379' }),
      /username requires a password/
    );
    await assert.rejects(
      createRedisQueueDriver({ url: 'redis://127.0.0.1:6379/not-a-database' }),
      /database must be a non-negative integer/
    );
    await assert.rejects(
      createRedisQueueDriver({
        url: 'redis://127.0.0.1:6379',
        tls: { rejectUnauthorized: false }
      }),
      /TLS options require a rediss:\/\/ URL/
    );
    await assert.rejects(
      createRedisQueueDriver({ client: {} }),
      /need duplicate\(\)/
    );
  });
});
