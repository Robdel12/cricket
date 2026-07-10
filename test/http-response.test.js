import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import request from 'supertest';

import {
  created,
  defineEndpoint,
  defineModel,
  defineRule,
  field,
  ok,
  redirect,
  respond,
  tooManyRequests,
  withCookies,
  withHeaders,
  withResponseCleanup,
  z
} from '../src/index.js';
import {
  assertInternalErrorResponse,
  createHttpApp,
  rawHttpResponse,
  responseForHandlerResult
} from './fixtures/http.js';

describe('Cricket HTTP responses', () => {
  it('composes immutable transport metadata without freezing response bodies', () => {
    let body = {
      status: 'active'
    };
    let headers = {
      'X-Request-Id': 'req_123'
    };
    let cookies = [{
      name: 'session',
      value: 'signed-token'
    }];
    let cleanup = () => {};
    let response = withResponseCleanup(
      withCookies(
        withHeaders(respond(202, body), headers),
        cookies
      ),
      cleanup
    );

    headers['X-Request-Id'] = 'changed';
    cookies[0].value = 'changed';
    body.status = 'complete';

    assert.equal(Object.isFrozen(response), true);
    assert.equal(Object.isFrozen(response.headers), true);
    assert.equal(Object.isFrozen(response.cookies), true);
    assert.equal(response.status, 202);
    assert.equal(response.body, body);
    assert.equal(response.body.status, 'complete');
    assert.equal(response.headers['X-Request-Id'], 'req_123');
    assert.equal(response.cookies[0].value, 'signed-token');
    assert.equal(response.onClose, cleanup);
  });

  it('validates endpoint response contracts before sending success', async () => {
    let User = defineModel({
      name: 'User',
      table: 'user',
      row: {
        id: field.public(z.uuid()),
        email: field.private(z.email(), { sensitive: true }),
        name: field.public(z.string())
      }
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/users/me',
      response: z.object({
        user: User.public
      }),
      handler() {
        return ok({
          user: {
            id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
            email: 'driver@example.com',
            name: 'Driver'
          }
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/users/me');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'RESPONSE_CONTRACT_FAILED');
    assert.equal(response.body.error.message, 'Internal server error');
    assert.equal(response.body.error.issues, undefined);
  });

  it('keeps internal contract details available to error hooks', async () => {
    let observed;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/contract-failure',
      response: z.object({
        internalReference: z.string()
      }),
      handler() {
        return ok({});
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      onError(error) {
        observed = error;
      }
    });
    let response = await request(app)
      .get('/contract-failure');

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        code: 'RESPONSE_CONTRACT_FAILED',
        message: 'Internal server error'
      }
    });
    assert.equal(observed.code, 'RESPONSE_CONTRACT_FAILED');
    assert.deepEqual(observed.details.issues[0].path, ['internalReference']);
  });

  it('sends redacted internal errors and lets app error hooks observe failures', async () => {
    let observed;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/boom',
      handler() {
        throw new Error('database password leaked here');
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      onError(error, { request, response }) {
        observed = {
          message: error.message,
          path: request.path,
          status: response.status
        };
      }
    });
    let response = await request(app)
      .get('/boom');

    assertInternalErrorResponse(response);
    assert.deepEqual(observed, {
      message: 'database password leaked here',
      path: '/boom',
      status: 500
    });
  });

  it('maps framework errors to HTTP responses', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/limited',
      handler() {
        throw tooManyRequests('Slow down');
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/limited');

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Slow down'
      }
    });
  });

  it('does not leak partial success when response preparation fails', async () => {
    let failures = [
      {
        name: 'invalid status',
        result: () => respond(101, 'bad')
      },
      {
        name: 'hop-by-hop header',
        result: withHeaders(
          ok({ ok: true }),
          {
            'Transfer-Encoding': 'chunked',
            'x-success': 'nope'
          }
        )
      },
      {
        name: 'bad content length',
        result: withHeaders(
          ok('short'),
          {
            'content-length': '100',
            'x-success': 'nope'
          }
        )
      }
    ];

    for (let failure of failures) {
      let response = await responseForHandlerResult(failure.result);

      assert.equal(response.status, 500, failure.name);
      assert.equal(response.headers['x-success'], undefined, failure.name);
      assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR', failure.name);
    }
  });

  it('destroys stream bodies when response preparation fails', async () => {
    let stream = new PassThrough();
    let response = await responseForHandlerResult(withHeaders(
      ok(stream),
      {
        'Content-Length': '12'
      }
    ));

    assertInternalErrorResponse(response);
    assert.equal(stream.destroyed, true);
  });

  it('threads response-shaped rule facts without treating them as responses', async () => {
    let loadProjectStatus = defineRule('loadProjectStatus', ({ input }) => ({
      status: input.params.slug === 'signal-notes' ? 'active' : 'missing'
    }));
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      params: z.object({
        slug: z.string().min(1)
      }),
      rules: [loadProjectStatus],
      handler({ status }) {
        return ok({
          status
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/projects/signal-notes');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'active'
    });
  });

  it('treats transport-shaped handler objects as plain response bodies', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/jobs/current',
      response: z.object({
        status: z.literal('active'),
        redirect: z.string(),
        headers: z.object({
          owner: z.string()
        }),
        body: z.object({
          progress: z.number()
        })
      }),
      handler() {
        return {
          status: 'active',
          redirect: '/not-a-redirect',
          headers: {
            owner: 'app'
          },
          body: {
            progress: 50
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/jobs/current');

    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
    assert.deepEqual(response.body, {
      status: 'active',
      redirect: '/not-a-redirect',
      headers: {
        owner: 'app'
      },
      body: {
        progress: 50
      }
    });
  });

  it('rejects rule facts that replace existing context', async () => {
    let replaceInput = defineRule('replaceInput', () => ({
      input: {
        params: {
          slug: 'shadowed'
        }
      }
    }));
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      params: z.object({
        slug: z.string().min(1)
      }),
      rules: [replaceInput],
      handler() {
        return ok({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/projects/signal-notes');

    assertInternalErrorResponse(response);
  });

  it('writes headers, cookies, redirects, JSON, strings, and buffers', async () => {
    let endpoints = [
      defineEndpoint({
        method: 'get',
        path: '/headers',
        handler: () => withHeaders(
          ok({ ok: true }),
          {
            'X-Request-Id': 'req_123'
          }
        )
      }),
      defineEndpoint({
        method: 'post',
        path: '/sessions',
        handler: () => created({
          success: true
        })
      }),
      defineEndpoint({
        method: 'get',
        path: '/redirect',
        handler: () => redirect('/login')
      }),
      defineEndpoint({
        method: 'get',
        path: '/text',
        handler: () => withHeaders(
          ok('hello'),
          {
            'Content-Type': 'text/plain'
          }
        )
      }),
      defineEndpoint({
        method: 'get',
        path: '/buffer',
        handler: () => withHeaders(
          ok(Buffer.from('ABC')),
          {
            'Content-Type': 'application/octet-stream'
          }
        )
      })
    ];
    let app = await createHttpApp({
      endpoints
    });
    let headers = await request(app).get('/headers');
    let createdResponse = await request(app).post('/sessions');
    let redirectResponse = await request(app).get('/redirect');
    let text = await request(app).get('/text');
    let buffer = await request(app).get('/buffer');

    assert.equal(headers.headers['x-request-id'], 'req_123');
    assert.deepEqual(headers.body, { ok: true });
    assert.equal(createdResponse.status, 201);
    assert.deepEqual(createdResponse.body, { success: true });
    assert.equal(redirectResponse.status, 303);
    assert.equal(redirectResponse.headers.location, '/login');
    assert.equal(text.text, 'hello');
    assert.deepEqual(buffer.body, Buffer.from('ABC'));
  });

  it('serializes secure cookies and rejects unsafe cookie output', async () => {
    let good = await responseForHandlerResult(withCookies(
      ok({ ok: true }),
      [
        {
          name: '__Host-session',
          value: 'signed-token',
          options: {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            partitioned: true,
            path: '/'
          }
        }
      ]
    ));
    let bad = await responseForHandlerResult(withHeaders(
      ok({ ok: true }),
      {
        'Set-Cookie': '__Host-session=token; Path=/'
      }
    ));

    assert.match(good.headers['set-cookie'][0], /__Host-session=signed-token/);
    assert.match(good.headers['set-cookie'][0], /Secure/);
    assert.match(good.headers['set-cookie'][0], /SameSite=None/);
    assert.match(good.headers['set-cookie'][0], /Partitioned/);
    assertInternalErrorResponse(bad, {
      setCookie: true
    });
  });

  it('rejects duplicate raw cookie headers before request cookies are parsed', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cookies',
      handler({ request: cricketRequest }) {
        return ok({
          cookie: cricketRequest.cookies.session
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /cookies HTTP/1.1',
      'Host: api.example.test',
      'Cookie: session=first',
      'Cookie: session=second',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(response, /first|second/);
  });

  it('exposes request cookies to handlers as plain data', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/sessions/current',
      handler({ request: cricketRequest }) {
        return ok({
          accessToken: cricketRequest.cookies.accessToken,
          refreshToken: cricketRequest.cookies.refreshToken
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/sessions/current')
      .set('cookie', [
        'accessToken=signed-token',
        'refreshToken=signed-refresh'
      ]);

    assert.deepEqual(response.body, {
      accessToken: 'signed-token',
      refreshToken: 'signed-refresh'
    });
  });

  it('does not send bodies for HEAD, redirects, or empty statuses', async () => {
    let stream = Readable.from(['ignored']);
    let endpoints = [
      defineEndpoint({
        method: 'get',
        path: '/head',
        handler: () => withHeaders(
          ok(stream),
          {
            'Content-Type': 'text/plain'
          }
        )
      }),
      defineEndpoint({
        method: 'delete',
        path: '/sessions/current',
        handler: () => withHeaders(
          respond(204, { success: true }),
          {
            'Content-Length': '16',
            'Content-Type': 'application/json'
          }
        )
      }),
      defineEndpoint({
        method: 'get',
        path: '/redirect-body',
        handler: () => redirect('/login')
      })
    ];
    let app = await createHttpApp({
      endpoints
    });
    let head = await request(app).head('/head');
    let empty = await request(app).delete('/sessions/current');
    let redirectResponse = await request(app).get('/redirect-body');

    assert.equal(head.text, undefined);
    assert.equal(stream.destroyed, true);
    assert.equal(empty.status, 204);
    assert.equal(empty.headers['content-type'], undefined);
    assert.equal(empty.text, '');
    assert.equal(redirectResponse.status, 303);
    assert.equal(redirectResponse.text, '');
  });

  it('streams Node response bodies and runs cleanup on close', async () => {
    let cleanedUp = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events',
      handler() {
        return withResponseCleanup(
          withHeaders(
            ok(Readable.from(['event: snapshot\n', 'data: {"ok":true}\n\n'])),
            {
            'Content-Type': 'text/event-stream'
            }
          ),
          () => {
            cleanedUp = true;
          }
        );
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await request(app)
      .get('/events');

    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.equal(response.text, 'event: snapshot\ndata: {"ok":true}\n\n');
    assert.equal(cleanedUp, true);
  });
});
