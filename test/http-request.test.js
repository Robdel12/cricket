import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import {
  created,
  defineEndpoint,
  ok,
  z
} from '../src/index.js';
import {
  createHttpApp,
  expectContinueResponse,
  rawHttpResponse
} from './fixtures/http.js';

describe('Cricket HTTP requests', () => {
  it('rejects GET request bodies before routing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/search',
      handler() {
        called = true;
        return ok({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/search')
      .set('content-type', 'text/plain')
      .send('unexpected');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'GET requests cannot include a body');
    assert.equal(called, false);
  });


  it('rejects HEAD request bodies before routing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'head',
      path: '/search',
      handler() {
        called = true;
        return {
          status: 200,
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'HEAD /search HTTP/1.1',
      'Host: api.example.test',
      'Content-Length: 10',
      'Connection: close',
      '',
      'unexpected'
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal(called, false);
  });


  it('rejects chunked GET request bodies before routing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/search',
      handler() {
        called = true;
        return ok({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /search HTTP/1.1',
      'Host: api.example.test',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '4',
      'body',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal(called, false);
  });


  it('normalizes request input before endpoint validation', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/projects',
      normalize(request) {
        return {
          body: {
            name: request.body.project_name
          }
        };
      },
      body: z.object({
        name: z.string()
      }),
      response: z.object({
        success: z.literal(true),
        name: z.string()
      }),
      handler({ input }) {
        return created({
          success: true,
          name: input.body.name
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/projects')
      .send({ project_name: 'radar note' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      success: true,
      name: 'radar note'
    });
  });


  it('preserves JSON null request bodies for endpoint validation', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events/null',
      body: z.null(),
      response: z.object({
        bodyIsNull: z.literal(true)
      }),
      handler({ input }) {
        return ok({
          bodyIsNull: input.body === null
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events/null')
      .set('content-type', 'application/json')
      .send('null');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      bodyIsNull: true
    });
  });


  it('checks auth before request body validation', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/private-projects',
      auth: true,
      body: z.object({
        name: z.string()
      }),
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });

    let unauthenticated = await request(app)
      .post('/private-projects')
      .send({
        wrong: true
      });
    let authenticated = await request(app)
      .post('/private-projects')
      .set('authorization', 'Bearer user_123')
      .send({
        wrong: true
      });

    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');
    assert.equal(authenticated.status, 422);
    assert.equal(authenticated.body.error.code, 'VALIDATION_FAILED');
  });


  it('checks auth before parsing malformed request bodies', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/private-events',
      auth: true,
      body: z.object({
        event: z.string()
      }),
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });

    let unauthenticated = await request(app)
      .post('/private-events')
      .set('content-type', 'application/json')
      .send('{"event":');
    let authenticated = await request(app)
      .post('/private-events')
      .set('authorization', 'Bearer user_123')
      .set('content-type', 'application/json')
      .send('{"event":');

    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');
    assert.equal(authenticated.status, 400);
    assert.equal(authenticated.body.error.code, 'BAD_REQUEST');
  });


  it('checks auth before buffering oversized request bodies', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/private-uploads',
      auth: true,
      maxBodyBytes: 4,
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });

    let unauthenticated = await request(app)
      .post('/private-uploads')
      .set('content-type', 'text/plain')
      .send('larger than four bytes');
    let authenticated = await request(app)
      .post('/private-uploads')
      .set('authorization', 'Bearer user_123')
      .set('content-type', 'text/plain')
      .send('larger than four bytes');

    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');
    assert.equal(authenticated.status, 413);
    assert.equal(authenticated.body.error.code, 'PAYLOAD_TOO_LARGE');
  });


  it('rejects unauthenticated expect-continue requests before allowing the body', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/private-uploads',
      auth: true,
      body: z.object({
        name: z.string()
      }),
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });
    let response = await expectContinueResponse(app, [
      'POST /private-uploads HTTP/1.1',
      'Host: api.example.test',
      'Expect: 100-continue',
      'Content-Type: application/json',
      'Content-Length: 15',
      'Connection: close',
      '',
      ''
    ].join('\r\n'), '{"name":"Whip"}');

    assert.doesNotMatch(response, /100 Continue/);
    assert.match(response, /^HTTP\/1\.1 401 /);
  });


  it('continues authenticated expect-continue requests only after preflight', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/private-uploads',
      auth: true,
      body: z.object({
        name: z.string()
      }),
      handler({ input }) {
        return created({
          name: input.body.name
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });
    let response = await expectContinueResponse(app, [
      'POST /private-uploads HTTP/1.1',
      'Host: api.example.test',
      'Authorization: Bearer user_123',
      'Expect: 100-continue',
      'Content-Type: application/json',
      'Content-Length: 15',
      'Connection: close',
      '',
      ''
    ].join('\r\n'), '{"name":"Whip"}');

    assert.match(response, /^HTTP\/1\.1 100 Continue/);
    assert.match(response, /HTTP\/1\.1 201 Created/);
    assert.match(response, /"name":"Whip"/);
  });


  it('rejects unsupported Expect headers before app hooks or handlers run', async () => {
    let hookCalled = false;
    let handlerCalled = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      handler() {
        handlerCalled = true;
        return created({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      use: [
        async (exchange, next) => {
          hookCalled = true;
          return await next(exchange);
        }
      ]
    });
    let response = await rawHttpResponse(app, [
      'POST /uploads HTTP/1.1',
      'Host: api.example.test',
      'Expect: surprise-me',
      'Content-Length: 15',
      'Connection: close',
      '',
      '{"name":"Whip"}'
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 417 Expectation Failed/);
    assert.match(response, /"code":"EXPECTATION_FAILED"/);
    assert.equal(hookCalled, false);
    assert.equal(handlerCalled, false);
  });


  it('reads raw request bodies for signed webhook endpoints before body parsing', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/webhooks/stripe',
      rawBody: true,
      response: z.object({
        rawBody: z.string(),
        parsedBodyType: z.literal('undefined')
      }),
      async handler({ request }) {
        return ok({
          rawBody: request.rawBody,
          parsedBodyType: typeof request.body
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{"event":"invoice.created"}');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      rawBody: '{"event":"invoice.created"}',
      parsedBodyType: 'undefined'
    });
  });


  it('rejects ambiguous Content-Type headers before parsing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let body = '{"event":"build.created"}';
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: api.example.test',
      'Content-Type: application/json',
      'Content-Type: text/plain',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Ambiguous Content-Type header"/);
    assert.equal(called, false);
  });


  it('rejects unsupported request body charsets as bad requests', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json; charset=made-up')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Unsupported request body charset');
    assert.equal(called, false);
  });


  it('rejects Node buffer encodings used as request body charsets', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json; charset=base64')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Unsupported request body charset');
    assert.equal(called, false);
  });


  it('rejects unsupported form charsets before validation', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/x-www-form-urlencoded; charset=hex')
      .send('event=build.created');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Unsupported request body charset');
    assert.equal(called, false);
  });


  it('rejects unsupported request content encodings before parsing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(response.body.error.message, 'Unsupported request content encoding');
    assert.equal(called, false);
  });


  it('rejects mixed request content encodings before parsing', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler: () => created({
        success: true
      })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json')
      .set('content-encoding', 'identity, gzip')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(response.body.error.message, 'Unsupported request content encoding');
  });


  it('accepts identity request content encoding', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      response: z.object({
        event: z.string()
      }),
      handler({ input }) {
        return ok({
          event: input.body.event
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json')
      .set('content-encoding', 'identity')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      event: 'build.created'
    });
  });


  it('rejects duplicate request trailer declarations before body parsing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler() {
        called = true;
        return ok({
          accepted: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1',
      'Transfer-Encoding: chunked',
      'Trailer: Expires',
      'Trailer: Digest',
      'Connection: close',
      '',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"message":"Unsupported Trailer header"/);
    assert.equal(called, false);
  });


  it('checks split Content-Encoding headers before parsing', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      handler() {
        called = true;
        return created({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let body = '{"event":"build.created"}';
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: api.example.test',
      'Content-Type: application/json',
      'Content-Encoding: identity',
      'Content-Encoding: gzip',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 415 /);
    assert.match(response, /"code":"UNSUPPORTED_MEDIA_TYPE"/);
    assert.match(response, /"message":"Unsupported request content encoding"/);
    assert.equal(called, false);
  });


  it('accepts quoted request body charsets', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      response: z.object({
        event: z.string()
      }),
      handler({ input }) {
        return ok({
          event: input.body.event
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/json; charset="utf-8"')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      event: 'build.created'
    });
  });


  it('rejects request bodies over the endpoint byte limit', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      maxBodyBytes: 4,
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/uploads')
      .set('content-type', 'text/plain')
      .send('larger than four bytes');

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
  });


  it('rejects conflicting body framing headers at the HTTP boundary', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler: () => ok({
        accepted: true
      })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Length: 4',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });


  it('rejects ambiguous transfer encoding headers at the HTTP boundary', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler: () => ok({
        accepted: true
      })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1',
      'Transfer-Encoding: chunked',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });


  it('rejects unsupported transfer encoding headers at the HTTP boundary', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler: () => ok({
        accepted: true
      })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1',
      'Transfer-Encoding: gzip',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });


  it('rejects request trailers before handlers can observe the request', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler() {
        called = true;
        return ok({
          accepted: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: 127.0.0.1',
      'Transfer-Encoding: chunked',
      'Content-Type: text/plain',
      'Trailer: Authorization',
      'Connection: close',
      '',
      '5',
      'hello',
      '0',
      'Authorization: Bearer shadow',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Unsupported Trailer header"/);
    assert.equal(called, false);
  });


  it('rejects connection-nominated authorization before context is built', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler() {
        called = true;
        return ok({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });
    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: api.example.test',
      'Connection: Authorization',
      'Authorization: Bearer trusted',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Unsupported Connection header"/);
    assert.equal(called, false);
  });


  it('rejects connection-nominated proxy metadata before origin is derived', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      handler({ request }) {
        return ok({
          origin: request.origin
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });
    let response = await rawHttpResponse(app, [
      'GET /where-am-i HTTP/1.1',
      'Host: internal.example.test',
      'Connection: X-Forwarded-Host',
      'X-Forwarded-Host: api.example.test',
      'X-Forwarded-Proto: https',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"message":"Unsupported Connection header"/);
  });


  it('enforces body byte limits for chunked requests without Content-Length', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/chunked-events',
      maxBodyBytes: 4,
      handler: () => ok({
        accepted: true
      })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'POST /chunked-events HTTP/1.1',
      'Host: 127.0.0.1',
      'Transfer-Encoding: chunked',
      'Content-Type: text/plain',
      'Connection: close',
      '',
      '5',
      'hello',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 413 /);
    assert.match(response, /"code":"PAYLOAD_TOO_LARGE"/);
  });


  it('preserves repeated query and form values as arrays', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/filters',
      body: z.object({
        tag: z.array(z.string())
      }),
      query: z.object({
        include: z.array(z.string())
      }),
      response: z.object({
        bodyTags: z.array(z.string()),
        queryIncludes: z.array(z.string())
      }),
      handler({ input }) {
        return ok({
          bodyTags: input.body.tag,
          queryIncludes: input.query.include
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/filters?include=active&include=archived')
      .type('form')
      .send('tag=design&tag=api');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      bodyTags: ['design', 'api'],
      queryIncludes: ['active', 'archived']
    });
  });


  it('keeps prototype-shaped request keys as plain data', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/prototype-keys',
      handler({ request }) {
        return ok({
          cookieValue: request.cookies.__proto__,
          formValue: request.body.__proto__,
          polluted: Object.prototype.polluted,
          queryValue: request.query.__proto__
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/prototype-keys?__proto__=query')
      .set('cookie', '__proto__=cookie')
      .type('form')
      .send('__proto__=form');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      cookieValue: 'cookie',
      formValue: 'form',
      queryValue: 'query'
    });
    assert.equal(Object.prototype.polluted, undefined);
  });


  it('normalizes the whole request before validation and handler access', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/teams/:teamId/projects',
      normalize(request) {
        return {
          params: {
            teamId: request.params.teamId.toUpperCase()
          },
          query: {
            include: request.query.include ?? 'summary'
          }
        };
      },
      params: z.object({
        teamId: z.literal('TEAM-123')
      }),
      query: z.object({
        include: z.string()
      }),
      response: z.object({
        teamId: z.string(),
        include: z.string(),
        requestTeamId: z.string()
      }),
      handler({ input, request }) {
        return ok({
          teamId: input.params.teamId,
          include: input.query.include,
          requestTeamId: request.params.teamId
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/teams/team-123/projects');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      teamId: 'TEAM-123',
      include: 'summary',
      requestTeamId: 'TEAM-123'
    });
  });


  it('keeps endpoint normalizers scoped to request input fields', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/teams/:teamId/projects',
      normalize(request) {
        return {
          method: 'post',
          path: '/changed',
          params: {
            teamId: request.params.teamId.toUpperCase()
          },
          query: {
            include: 'summary'
          }
        };
      },
      params: z.object({
        teamId: z.literal('TEAM-123')
      }),
      query: z.object({
        include: z.string()
      }),
      response: z.object({
        method: z.string(),
        path: z.string(),
        teamId: z.string(),
        include: z.string()
      }),
      handler({ input, request }) {
        return ok({
          method: request.method,
          path: request.path,
          teamId: input.params.teamId,
          include: input.query.include
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/teams/team-123/projects');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      method: 'GET',
      path: '/teams/team-123/projects',
      teamId: 'TEAM-123',
      include: 'summary'
    });
  });


  it('parses structured JSON media types', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }),
      response: z.object({
        event: z.string()
      }),
      handler({ input }) {
        return ok({
          event: input.body.event
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/events')
      .set('content-type', 'application/vnd.cricket.event+json')
      .send('{"event":"build.created"}');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      event: 'build.created'
    });
  });


});
