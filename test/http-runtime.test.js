import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import request from 'supertest';

import {
  createCricketRuntime,
  defineCricketApp,
  defineEndpoint,
  ok,
  startCricketApp
} from '../src/index.js';
import {
  createHttpApp,
  rawHttpResponse
} from './fixtures/http.js';

describe('Cricket HTTP runtime', () => {
  it('closes malformed parser-level requests with a controlled bad request response', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /health HTTP/1.1',
      'Host: api.example.test',
      'Bad Header',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    assert.match(response, /Connection: close/i);
  });


  it('rejects CONNECT requests with a controlled close before routing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        called = true;
        return ok({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'CONNECT api.example.test:443 HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    assert.match(response, /Connection: close/i);
    assert.equal(called, false);
  });


  it('rejects protocol upgrade requests with a controlled close before routing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events',
      handler() {
        called = true;
        return ok({ accepted: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /events HTTP/1.1',
      'Host: api.example.test',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    assert.match(response, /Connection: close/i);
    assert.equal(called, false);
  });


  it('runs shutdown hooks before cleanup in started Cricket runtimes', async () => {
    let events = [];
    let sigintListeners = process.listenerCount('SIGINT');
    let sigtermListeners = process.listenerCount('SIGTERM');
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          success: true
        });
      }
    });
    let cricketApp = defineCricketApp({
      name: 'Lifecycle API',
      domains: [],
      endpoints: [endpoint],
      setup() {
        return {
          cleanup() {
            events.push('cleanup');
          }
        };
      },
      onShutdown({ signal }) {
        events.push(`shutdown:${signal}`);
      }
    });
    let runtime = await startCricketApp(cricketApp, {
      port: 0,
      logger: {}
    });

    await runtime.stop('SIGTERM');

    assert.deepEqual(events, [
      'shutdown:SIGTERM',
      'cleanup'
    ]);
    assert.equal(process.listenerCount('SIGINT'), sigintListeners);
    assert.equal(process.listenerCount('SIGTERM'), sigtermListeners);
  });


  it('runs cleanup when shutdown hooks fail', async () => {
    let events = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ success: true })
    });
    let cricketApp = defineCricketApp({
      endpoints: [endpoint],
      setup() {
        return {
          cleanup() {
            events.push('cleanup');
          }
        };
      },
      onShutdown() {
        events.push('shutdown');
        throw new Error('shutdown failed');
      }
    });
    let runtime = await startCricketApp(cricketApp, {
      port: 0,
      logger: {}
    });

    await assert.rejects(runtime.stop('SIGTERM'), /shutdown failed/);

    assert.deepEqual(events, [
      'shutdown',
      'cleanup'
    ]);
  });


  it('lets active streaming responses finish during idle-connection shutdown', async () => {
    let events = [];
    let stream = new PassThrough();
    let responseStarted;
    let responseStartedPromise = new Promise(resolve => {
      responseStarted = resolve;
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events',
      handler() {
        return {
          status: 200,
          headers: {
            'content-type': 'text/plain'
          },
          body: stream,
          onClose() {
            events.push('response:closed');
          }
        };
      }
    });
    let cricketApp = defineCricketApp({
      endpoints: [endpoint],
      setup() {
        return {
          cleanup() {
            events.push('cleanup');
          }
        };
      },
      onShutdown({ signal }) {
        events.push(`shutdown:${signal}`);
      }
    });
    let runtime = await startCricketApp(cricketApp, {
      port: 0,
      logger: {}
    });
    let { port } = runtime.server.address();
    let responsePromise = new Promise((resolve, reject) => {
      let req = http.get({
        host: '127.0.0.1',
        port,
        path: '/events',
        headers: {
          connection: 'close'
        }
      }, response => {
        let chunks = [];

        events.push('client:headers');
        responseStarted();
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          status: response.statusCode
        }));
      });

      req.on('error', reject);
    });

    stream.write('hello');
    await responseStartedPromise;

    let stopPromise = runtime.stop('SIGTERM', {
      closeConnections: 'idle'
    });

    stream.end(' world');

    let response = await responsePromise;
    await stopPromise;

    assert.equal(response.status, 200);
    assert.equal(response.body, 'hello world');
    assert.deepEqual(events, [
      'client:headers',
      'shutdown:SIGTERM',
      'response:closed',
      'cleanup'
    ]);
  });


});
