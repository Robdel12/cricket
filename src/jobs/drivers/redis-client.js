import net from 'node:net';
import nodeTls from 'node:tls';
import { once } from 'node:events';

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
      return {
        error: new Error(line.value.toString('utf8')),
        offset: line.offset
      };

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

export async function createRedisSocketClient(url, tlsOptions = {}) {
  if (!url)
    throw new Error('Redis queue configuration needs a url or app-provided client');

  let parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
    throw new Error('Redis queue URL must use redis:// or rediss://');

  let username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  let password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  let database;

  if (username && !password)
    throw new Error('Redis queue URL username requires a password');

  if (parsed.pathname && parsed.pathname !== '/') {
    database = parsed.pathname.slice(1);

    if (!/^\d+$/.test(database))
      throw new Error('Redis queue URL database must be a non-negative integer');
  }

  let connection = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379)
  };
  let secure = parsed.protocol === 'rediss:';

  if (!secure && Object.keys(tlsOptions).length)
    throw new Error('Redis queue TLS options require a rediss:// URL');

  let servername = tlsOptions.servername ?? (
    net.isIP(parsed.hostname) ? undefined : parsed.hostname
  );
  let socket = secure
    ? nodeTls.connect({
      ...tlsOptions,
      ...connection,
      ...(servername ? { servername } : {})
    })
    : net.createConnection(connection);
  let pending = [];
  let buffer = Buffer.alloc(0);

  function rejectPending(error) {
    while (pending.length)
      pending.shift().reject(error);
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (pending.length) {
      let response = parseResp(buffer);

      if (!response)
        return;

      buffer = buffer.slice(response.offset);
      let command = pending.shift();

      if (response.error)
        command.reject(response.error);
      else
        command.resolve(decodeRedisValue(response.value));
    }
  });
  socket.on('error', error => rejectPending(error));
  socket.on('close', () => rejectPending(new Error('Redis connection closed')));

  function sendCommand(...parts) {
    return new Promise((resolve, reject) => {
      pending.push({
        resolve,
        reject
      });
      socket.write(encodeCommand(parts));
    });
  }

  try {
    await once(socket, secure ? 'secureConnect' : 'connect');

    if (password)
      await sendCommand('AUTH', ...(username ? [username, password] : [password]));

    if (database)
      await sendCommand('SELECT', database);
  } catch (error) {
    socket.destroy();
    throw error;
  }

  return {
    command: sendCommand,
    async disconnect() {
      socket.destroy();
    },
    async quit() {
      socket.end();
      socket.destroy();
    }
  };
}

export async function redisCommand(client, name, ...args) {
  if (typeof client.command === 'function')
    return await client.command.call(client, name, ...args);

  if (typeof client.call === 'function')
    return await client.call.call(client, name, ...args);

  if (typeof client.sendCommand === 'function')
    return await client.sendCommand.call(client, [name, ...args.map(String)]);

  let method = client[name.toLowerCase()];

  if (typeof method === 'function')
    return await method.call(client, ...args);

  throw new Error('Redis client needs command, sendCommand, call, or command methods');
}
