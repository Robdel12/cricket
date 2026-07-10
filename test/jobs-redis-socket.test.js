import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createRedisQueueDriver } from '../src/jobs/drivers/redis.js';
import { deferred } from '../test-support/jobs.js';

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
  let nextConnectionId = 1;
  let server = net.createServer(socket => {
    let buffer = '';
    let connectionId = nextConnectionId;

    nextConnectionId += 1;

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
        let response = handleCommand(command, {
          connectionId
        });

        if (response !== undefined)
          socket.write(response);
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

describe('Cricket jobs: Redis socket', () => {
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

  it('keeps Redis commands usable while the worker blocks for a wakeup', async () => {
    let blocked = deferred();
    let blockingConnection;
    let commandConnections = [];
    let redis = await createRespRedisServer(([command], {
      connectionId
    }) => {
      if (command === 'BLPOP') {
        blockingConnection = connectionId;
        blocked.resolve();
        return undefined;
      }

      commandConnections.push(connectionId);

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
    } finally {
      controller.abort();
      await driver.cleanup();
      await redis.close();
    }
  });
});
