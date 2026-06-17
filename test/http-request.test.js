import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import {
  defineEndpoint,
  ok,
  toHttpError,
  unauthenticated,
  z
} from '../src/index.js';
import {
  createHttpApp,
  expectContinueResponse,
  rawHttpResponse
} from './fixtures/http.js';

function endpointFor(method = 'post', options = {}) {
  return defineEndpoint({
    method,
    path: options.path ?? '/events',
    body: options.body,
    maxBodyBytes: options.maxBodyBytes,
    rawBody: options.rawBody,
    handler({ input, request: cricketRequest }) {
      return ok({
        body: input.body,
        cookies: cricketRequest.cookies,
        query: cricketRequest.query,
        rawBody: cricketRequest.rawBody
      });
    }
  });
}

describe('Cricket HTTP requests', () => {
  for (let requestCase of [
    {
      name: 'GET request body',
      payload: [
        'GET /events HTTP/1.1',
        'Host: api.example.test',
        'Content-Length: 4',
        'Connection: close',
        '',
        'body'
      ]
    },
    {
      name: 'HEAD request body',
      payload: [
        'HEAD /events HTTP/1.1',
        'Host: api.example.test',
        'Content-Length: 4',
        'Connection: close',
        '',
        'body'
      ]
    },
    {
      name: 'chunked GET request body',
      payload: [
        'GET /events HTTP/1.1',
        'Host: api.example.test',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '4',
        'body',
        '0',
        '',
        ''
      ]
    }
  ]) {
    it(`rejects ${requestCase.name} before routing`, async () => {
      let called = false;
      let endpoint = defineEndpoint({
        method: 'get',
        path: '/events',
        handler() {
          called = true;
          return ok({ success: true });
        }
      });
      let app = await createHttpApp({
        endpoints: [endpoint]
      });
      let response = await rawHttpResponse(app, requestCase.payload.join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.equal(called, false);
    });
  }

  it('parses JSON, structured JSON, forms, query strings, and cookies as plain data', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      body: z.object({
        event: z.string()
      }).nullable(),
      handler({ input, request: cricketRequest }) {
        return ok({
          body: input.body,
          cookie: cricketRequest.cookies.session,
          query: cricketRequest.query.include,
          repeatedQuery: cricketRequest.query.tag
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let json = await request(app)
      .post('/events?include=summary&tag=a&tag=b')
      .set('cookie', 'session=signed')
      .type('application/activity+json')
      .send({ event: 'created' });
    let nullable = await request(app)
      .post('/events')
      .type('json')
      .send('null');

    assert.deepEqual(json.body, {
      body: { event: 'created' },
      cookie: 'signed',
      query: 'summary',
      repeatedQuery: ['a', 'b']
    });
    assert.deepEqual(nullable.body.body, null);
  });

  it('lets middleware reject invalid, oversized, or expect-continue bodies before parsing', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/protected',
      maxBodyBytes: 4,
      body: z.object({
        name: z.string()
      }),
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      middleware: [
        async requestContext => {
          if (!requestContext.request.headers.authorization)
            return {
              status: 401,
              body: {
                error: {
                  code: 'UNAUTHENTICATED',
                  message: 'Unauthenticated'
                }
              }
            };
        }
      ]
    });
    let malformed = await request(app)
      .post('/protected')
      .type('json')
      .send('{bad json');
    let oversized = await request(app)
      .post('/protected')
      .type('text')
      .send('too large');
    let expect = await expectContinueResponse(app, [
      'POST /protected HTTP/1.1',
      'Host: api.example.test',
      'Content-Type: application/json',
      'Content-Length: 15',
      'Expect: 100-continue',
      'Connection: close',
      '',
      ''
    ].join('\r\n'), '{"name":"Radar"}');

    assert.equal(malformed.status, 401);
    assert.equal(oversized.status, 401);
    assert.match(expect, /^HTTP\/1\.1 401 /);
    assert.doesNotMatch(expect, /^HTTP\/1\.1 100 Continue/);
  });

  it('allows middleware-approved expect-continue requests after preflight', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/protected',
      body: z.object({
        name: z.string()
      }),
      handler({ input }) {
        return ok({
          name: input.body.name
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      middleware: [
        async (requestContext, next) => {
          if (!requestContext.request.headers.authorization)
            return toHttpError(unauthenticated());

          return await next(requestContext);
        }
      ]
    });
    let response = await expectContinueResponse(app, [
      'POST /protected HTTP/1.1',
      'Host: api.example.test',
      'Authorization: Bearer token',
      'Content-Type: application/json',
      'Content-Length: 16',
      'Expect: 100-continue',
      'Connection: close',
      '',
      ''
    ].join('\r\n'), '{"name":"Radar"}');

    assert.match(response, /^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 /);
    assert.match(response, /"name":"Radar"/);
  });

  it('reads raw bodies for signed webhook endpoints', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/webhooks/stripe',
      rawBody: true,
      response: z.object({
        rawBody: z.string()
      }),
      handler({ request: cricketRequest }) {
        return ok({
          rawBody: cricketRequest.rawBody
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .post('/webhooks/stripe')
      .type('json')
      .send({ event: 'invoice.created' });

    assert.deepEqual(response.body, {
      rawBody: '{"event":"invoice.created"}'
    });
  });

  for (let badRequest of [
    {
      name: 'ambiguous Content-Type',
      headers: [
        'Content-Type: application/json',
        'Content-Type: text/plain'
      ],
      body: '{"event":"created"}'
    },
    {
      name: 'unsupported charset',
      headers: [
        'Content-Type: application/json; charset=utf-16'
      ],
      body: '{"event":"created"}'
    }
  ]) {
    it(`rejects ${badRequest.name} before parsing`, async () => {
      let endpoint = endpointFor('post', {
        body: z.object({
          event: z.string()
        })
      });
      let app = await createHttpApp({
        endpoints: [endpoint]
      });
      let response = await rawHttpResponse(app, [
        'POST /events HTTP/1.1',
        'Host: api.example.test',
        ...badRequest.headers,
        `Content-Length: ${Buffer.byteLength(badRequest.body)}`,
        'Connection: close',
        '',
        badRequest.body
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 |^HTTP\/1\.1 415 /);
    });
  }

  for (let badRequest of [
    {
      name: 'conflicting body framing',
      headers: [
        'Content-Type: application/json',
        'Content-Length: 19',
        'Transfer-Encoding: chunked'
      ],
      body: '0\r\n\r\n'
    },
    {
      name: 'ambiguous transfer encoding',
      headers: [
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Transfer-Encoding: identity'
      ],
      body: '0\r\n\r\n'
    },
    {
      name: 'unsupported transfer encoding',
      headers: [
        'Content-Type: application/json',
        'Transfer-Encoding: gzip'
      ],
      body: ''
    }
  ]) {
    it(`rejects ${badRequest.name} at the HTTP boundary`, async () => {
      let endpoint = endpointFor('post', {
        body: z.object({
          event: z.string()
        })
      });
      let app = await createHttpApp({
        endpoints: [endpoint]
      });
      let response = await rawHttpResponse(app, [
        'POST /events HTTP/1.1',
        'Host: api.example.test',
        ...badRequest.headers,
        'Connection: close',
        '',
        badRequest.body
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 |^HTTP\/1\.1 413 /);
    });
  }

  it('enforces endpoint body byte limits for fixed and chunked bodies', async () => {
    let endpoint = endpointFor('post', {
      body: z.string(),
      maxBodyBytes: 4
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let fixed = await request(app)
      .post('/events')
      .type('text')
      .send('too large');
    let chunked = await rawHttpResponse(app, [
      'POST /events HTTP/1.1',
      'Host: api.example.test',
      'Content-Type: text/plain',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '9',
      'too large',
      '0',
      '',
      ''
    ].join('\r\n'));

    assert.equal(fixed.status, 413);
    assert.match(chunked, /^HTTP\/1\.1 413 /);
  });

  it('rejects duplicate authorization before context is built', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler() {
        called = true;
        return ok({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true,
      context({ request: cricketRequest }) {
        return {
          user: cricketRequest.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });

    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: api.example.test',
      'Authorization: Bearer trusted',
      'Authorization: Bearer shadow',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal(called, false);
  });

  it('keeps prototype-shaped input as plain data', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/prototype-keys',
      handler({ request: cricketRequest }) {
        return ok({
          cookieValue: cricketRequest.cookies.__proto__,
          formValue: cricketRequest.body.__proto__,
          queryValue: cricketRequest.query.__proto__
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

    assert.deepEqual(response.body, {
      cookieValue: 'cookie',
      formValue: 'form',
      queryValue: 'query'
    });
    assert.equal(Object.prototype.polluted, undefined);
  });
});
