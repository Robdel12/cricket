import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import request from 'supertest';

import {
  createCricketRuntime,
  defineCricketApp,
  defineEndpoint,
  generateOpenApi,
  ok,
  startCricketApp,
  z
} from '../src/index.js';
import {
  createHttpApp,
  rawHttpResponse
} from './fixtures/http.js';

describe('Cricket HTTP runtime', () => {
  it('emits safe lifecycle events with request IDs, route identity, and replay', async () => {
    let events = [];
    let mutatedEvents = [];
    let loggerChildren = [];
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/projects/:projectId',
      operationId: 'createProjectById',
      body: z.object({
        name: z.string()
      }),
      handler({ logger, request }) {
        logger.info('handler.called');

        return {
          status: 201,
          cookies: [
            {
              name: 'session',
              value: 'response-secret',
              options: {
                httpOnly: true
              }
            }
          ],
          body: {
            id: request.params.projectId,
            name: request.body.name
          }
        };
      }
    });
    let cricketApp = defineCricketApp({
      endpoints: [endpoint],
      observability: {
        requestId() {
          return 'req_observable_1';
        },
        observe: [
          event => {
            try {
              event.request.headers.push('mutated');
            } catch {
              // Frozen observer payloads may reject mutation.
            }

            mutatedEvents.push(event);
          },
          event => events.push(event)
        ]
      }
    });
    let runtime = await createCricketRuntime(cricketApp, {
      logger: {
        child(metadata) {
          loggerChildren.push(metadata);
          return {
            info() {}
          };
        }
      }
    });

    let response = await request(runtime.app)
      .post('/projects/018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0?token=query-secret')
      .set('authorization', 'Bearer auth-secret')
      .set('cookie', 'session=request-secret')
      .send({ name: 'Launch Plan' });

    assert.equal(response.status, 201);
    assert.deepEqual(loggerChildren, [
      {
        requestId: 'req_observable_1'
      }
    ]);
    assert.deepEqual(events.map(event => event.type), [
      'request.started',
      'route.matched',
      'response.finished'
    ]);
    assert.equal(events[0].requestId, 'req_observable_1');
    assert.equal(events[0].request.method, 'POST');
    assert.equal(events[0].request.path, '/projects/018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0');
    assert.ok(events[0].request.headers.includes('authorization'));
    assert.ok(events[0].request.headers.includes('cookie'));
    assert.equal(events[0].request.headers.includes('mutated'), false);
    assert.equal(mutatedEvents[0].request.headers.includes('mutated'), false);
    assert.deepEqual(events[0].request.cookies, ['session']);
    assert.deepEqual(events[0].request.query, ['token']);
    assert.equal(events[0].request.hasBody, false);
    assert.deepEqual(events[1].route, {
      method: 'POST',
      path: '/projects/:projectId',
      operationId: 'createProjectById'
    });
    assert.deepEqual(events[1].request.params, ['projectId']);
    assert.equal(events[2].response.status, 201);
    assert.deepEqual(events[2].response.cookies, ['session']);
    assert.equal(events[2].response.body, 'json');
    assert.deepEqual(events[2].replay.map(event => event.type), [
      'request.started',
      'route.matched',
      'response.finished'
    ]);

    let serializedEvents = JSON.stringify(events);

    assert.equal(serializedEvents.includes('auth-secret'), false);
    assert.equal(serializedEvents.includes('request-secret'), false);
    assert.equal(serializedEvents.includes('response-secret'), false);
    assert.equal(serializedEvents.includes('query-secret'), false);
    assert.equal(serializedEvents.includes('Launch Plan'), false);
  });


  it('supports function-style observers and wire-level empty body snapshots', async () => {
    let events = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          success: true
        });
      }
    });
    let runtime = await createCricketRuntime(defineCricketApp({
      endpoints: [endpoint],
      observability(event) {
        events.push(event);
      }
    }), {
      logger: {}
    });

    let response = await request(runtime.app)
      .head('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(events.map(event => event.type), [
      'request.started',
      'route.matched',
      'response.finished'
    ]);
    assert.deepEqual(events[1].route, {
      method: 'GET',
      path: '/health',
      operationId: 'getHealth'
    });
    assert.equal(events[2].response.body, 'empty');
  });


  it('keeps runtime route operation IDs aligned with OpenAPI under prefixes', async () => {
    let events = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:projectId',
      params: z.object({
        projectId: z.uuid()
      }),
      handler() {
        return ok({
          success: true
        });
      }
    });
    let cricketApp = defineCricketApp({
      prefix: '/api',
      endpoints: [endpoint],
      observability(event) {
        events.push(event);
      }
    });
    let runtime = await createCricketRuntime(cricketApp, {
      logger: {}
    });
    let docs = generateOpenApi({
      title: 'Projects API',
      version: '1.0.0',
      pathPrefix: '/api',
      endpoints: [endpoint]
    });

    let response = await request(runtime.app)
      .get('/api/projects/018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0');

    assert.equal(response.status, 200);
    assert.deepEqual(events[1].route, {
      method: 'GET',
      path: '/api/projects/:projectId',
      operationId: docs.paths['/api/projects/{projectId}'].get.operationId
    });
  });


  it('threads structured request logs through the runtime', async () => {
    let logs = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:projectId',
      operationId: 'getProject',
      handler({ logger, request }) {
        logger.info('handler.called', {
          authorization: 'Bearer should-redact'
        });

        return ok({
          success: true,
          id: request.params.projectId
        });
      }
    });
    let cricketApp = defineCricketApp({
      name: 'Project API',
      logger: {
        format: 'json',
        write(line) {
          logs.push(JSON.parse(line));
        }
      },
      endpoints: [endpoint],
      observability: {
        requestId() {
          return 'req_log_1';
        }
      }
    });
    let runtime = await createCricketRuntime(cricketApp);

    let response = await request(runtime.app)
      .get('/projects/018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0?token=query-secret')
      .set('authorization', 'Bearer auth-secret')
      .set('cookie', 'session=request-secret');

    assert.equal(response.status, 200);
    assert.deepEqual(logs.map(log => log.event), [
      'http.request.started',
      'http.route.matched',
      'handler.called',
      'http.response.finished'
    ]);

    let handlerLog = logs.find(log => log.event === 'handler.called');
    let responseLog = logs.find(log => log.event === 'http.response.finished');

    assert.equal(handlerLog.service, 'Project API');
    assert.equal(handlerLog.requestId, 'req_log_1');
    assert.deepEqual(handlerLog.route, {
      method: 'GET',
      path: '/projects/:projectId',
      operationId: 'getProject'
    });
    assert.equal(handlerLog.metadata.authorization, '[Redacted]');
    assert.equal(responseLog.metadata.response.status, 200);

    let serializedLogs = JSON.stringify(logs);

    assert.equal(serializedLogs.includes('auth-secret'), false);
    assert.equal(serializedLogs.includes('request-secret'), false);
    assert.equal(serializedLogs.includes('query-secret'), false);
    assert.equal(serializedLogs.includes('should-redact'), false);
  });


  it('emits response.closed when a client closes a streaming response early', async () => {
    let events = [];
    let stream = new PassThrough();
    let resolveClosed;
    let closedEventPromise = new Promise(resolve => {
      resolveClosed = resolve;
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
          body: stream
        };
      }
    });
    let runtime = await startCricketApp(defineCricketApp({
      endpoints: [endpoint],
      observability(event) {
        events.push(event);

        if (event.type === 'response.closed')
          resolveClosed(event);
      }
    }), {
      port: 0,
      logger: {}
    });
    let { port } = runtime.server.address();
    let clientClosedPromise = new Promise((resolve, reject) => {
      let clientRequest = http.get({
        host: '127.0.0.1',
        port,
        path: '/events',
        headers: {
          connection: 'close'
        }
      }, response => {
        response.on('close', resolve);
        response.on('error', reject);
        response.destroy();
      });

      clientRequest.on('error', reject);
    });

    stream.write('hello');

    let closedEvent = await closedEventPromise;
    await clientClosedPromise;
    stream.destroy();
    await runtime.stop('SIGTERM', {
      closeConnections: 'all'
    });

    assert.equal(closedEvent.type, 'response.closed');
    assert.equal(closedEvent.response.body, 'stream');
    assert.deepEqual(closedEvent.replay.map(event => event.type), [
      'request.started',
      'route.matched',
      'response.closed'
    ]);
  });


  it('emits redacted failure events and keeps observer failures out of responses', async () => {
    let events = [];
    let loggerEvents = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/explode',
      handler() {
        throw new Error('database password hunter2');
      }
    });
    let cricketApp = defineCricketApp({
      endpoints: [endpoint],
      observability: {
        requestId() {
          return 'req_failure_1';
        },
        observe(event) {
          events.push(event);

          if (event.type === 'route.matched')
            throw new Error('observer failed');
        }
      }
    });
    let runtime = await createCricketRuntime(cricketApp, {
      logger: {
        error(event, metadata) {
          loggerEvents.push({
            event,
            metadata
          });
        }
      }
    });

    let response = await request(runtime.app)
      .get('/explode')
      .set('authorization', 'Bearer auth-secret');

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
    assert.deepEqual(events.map(event => event.type), [
      'request.started',
      'route.matched',
      'request.failed',
      'response.finished'
    ]);
    assert.deepEqual(events[2].error, {
      code: undefined,
      name: 'Error'
    });
    assert.ok(loggerEvents.some(event => event.event === 'observability.failed'));

    let serializedEvents = JSON.stringify(events);

    assert.equal(serializedEvents.includes('hunter2'), false);
    assert.equal(serializedEvents.includes('auth-secret'), false);
  });


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
