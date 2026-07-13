import assert from 'node:assert/strict';
import net from 'node:net';
import request from 'supertest';

import {
  createCricketRuntime,
  defineEndpoint
} from '../../src/index.js';
import { defineManualTestApp } from '../../test-support/app.js';

export async function createHttpApp(options) {
  let runtime = await createCricketRuntime(defineManualTestApp(options), {
    logger() {}
  });
  return runtime.app;
}

export async function responseForHandlerResult(result) {
  let endpoint = defineEndpoint({
    method: 'get',
    path: '/response',
    handler() {
      return typeof result === 'function' ? result() : result;
    }
  });
  let app = await createHttpApp({
    endpoints: [endpoint]
  });

  return await request(app)
    .get('/response');
}

export function assertInternalErrorResponse(response, {
  setCookie = false
} = {}) {
  assert.equal(response.status, 500);
  assert.equal(response.headers['x-success'], undefined);

  if (setCookie)
    assert.equal(response.headers['set-cookie'], undefined);

  assert.deepEqual(response.body, {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error'
    }
  });
}

export async function rawHttpResponse(app, payload) {
  let server = await new Promise(resolve => {
    let listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let { port } = server.address();

  try {
    return await new Promise((resolve, reject) => {
      let chunks = [];
      let socket = net.createConnection({
        host: '127.0.0.1',
        port
      }, () => {
        socket.end(payload);
      });

      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

export async function expectContinueResponse(app, headers, body) {
  let server = await new Promise(resolve => {
    let listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let { port } = server.address();

  try {
    return await new Promise((resolve, reject) => {
      let chunks = [];
      let sentBody = false;
      let socket = net.createConnection({
        host: '127.0.0.1',
        port
      }, () => {
        socket.write(headers);
      });

      socket.on('data', chunk => {
        chunks.push(chunk);
        let response = Buffer.concat(chunks).toString('utf8');

        if (!sentBody && /^HTTP\/1\.1 100 Continue\r\n\r\n/.test(response)) {
          sentBody = true;
          socket.end(body);
        } else if (!sentBody && /^HTTP\/1\.1 (?!100 )/.test(response)) {
          sentBody = true;
          socket.end();
        }
      });
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}
