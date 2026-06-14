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
  tooManyRequests,
  z
} from '../src/index.js';
import {
  assertInternalErrorResponse,
  createHttpApp,
  rawHttpResponse,
  responseForHandlerResult
} from './fixtures/http.js';

describe('Cricket HTTP responses', () => {
  it('rejects private field leaks at the endpoint response boundary', async () => {
    let User = defineModel({
      name: 'User',
      table: 'user',
      row: {
        id: field.public(z.uuid()),
        email: field.private(z.email()),
        name: field.public(z.string())
      }
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/users/me',
      response: z.object({
        user: User.public
      }),
      async handler() {
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
  });



  it('redacts generic internal error messages', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/secret',
      handler() {
        throw new Error('database password leaked');
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/secret');

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('still sends the original error response when onError throws', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/secret',
      handler() {
        throw new Error('database password leaked');
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      onError() {
        throw new Error('reporting failed');
      }
    });

    let response = await request(app)
      .get('/secret');

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('maps rate limit errors to 429 responses', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/drive-sessions',
      handler() {
        throw tooManyRequests('Slow down and retry in a moment');
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/drive-sessions');

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Slow down and retry in a moment'
      }
    });
  });



  it('does not leak success metadata when response preparation fails', async () => {
    let body = {};
    body.self = body;
    let cases = [
      {
        name: 'circular JSON',
        result: {
          status: 200,
          headers: {
            'x-success': 'should-not-leak'
          },
          cookies: [
            {
              name: 'session',
              value: 'should-not-leak'
            }
          ],
          body
        },
        setCookie: true
      },
      {
        name: 'invalid status',
        result: {
          status: 99,
          headers: {
            'x-success': 'should-not-leak'
          },
          body: {
            ok: true
          }
        }
      },
      {
        name: 'informational status',
        result: {
          status: 101,
          headers: {
            Upgrade: 'websocket',
            'x-success': 'should-not-leak'
          },
          body: 'upgraded'
        }
      },
      {
        name: 'hop-by-hop header',
        result: {
          status: 200,
          headers: {
            'Transfer-Encoding': 'chunked',
            'X-Success': 'should-not-leak'
          },
          body: {
            ok: true
          }
        }
      },
      {
        name: 'hop-by-hop Fetch Response header',
        result: () => new Response('hello', {
          status: 200,
          headers: {
            Connection: 'close',
            'X-Success': 'should-not-leak'
          }
        })
      },
      {
        name: 'invalid content length',
        result: {
          status: 200,
          headers: {
            'content-length': 'abc',
            'x-success': 'should-not-leak'
          },
          body: 'hello'
        }
      },
      {
        name: 'mismatched content length',
        result: {
          status: 200,
          headers: {
            'content-length': '100',
            'x-success': 'should-not-leak'
          },
          body: 'hello'
        }
      },
      {
        name: 'empty body content length mismatch',
        result: {
          status: 200,
          headers: {
            'content-length': '1',
            'x-success': 'should-not-leak'
          }
        }
      }
    ];

    for (let testCase of cases) {
      let response = await responseForHandlerResult(testCase.result);
      assertInternalErrorResponse(response, {
        setCookie: testCase.setCookie
      });
    }
  });



  it('closes streams and runs cleanup when response preparation fails', async () => {
    let cleanedUp = false;
    let stream = new PassThrough();
    let response = await responseForHandlerResult({
      status: 200,
      headers: {
        'content-length': '5',
        'x-success': 'should-not-leak'
      },
      body: stream,
      onClose() {
        cleanedUp = true;
      }
    });

    assertInternalErrorResponse(response);
    assert.equal(stream.destroyed, true);
    assert.equal(cleanedUp, true);
  });



  it('runs response cleanup when response headers are rejected', async () => {
    let cleanedUp = false;
    let response = await responseForHandlerResult({
      status: 200,
      headers: {
        Connection: 'close',
        'x-success': 'should-not-leak'
      },
      body: {
        ok: true
      },
      onClose() {
        cleanedUp = true;
      }
    });

    assertInternalErrorResponse(response);
    assert.equal(cleanedUp, true);
  });



  it('rejects response cookie header injection before writing success headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/bad-cookie',
      handler() {
        return {
          status: 200,
          headers: {
            'x-success': 'should-not-leak'
          },
          cookies: [
            {
              name: 'session',
              value: 'token',
              options: {
                path: '/\r\nx-injected: yes'
              }
            }
          ],
          body: {
            ok: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/bad-cookie');

    assert.equal(response.status, 500);
    assert.equal(response.headers['x-success'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('rejects insecure modern cookie attributes before writing success headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/bad-modern-cookie',
      handler() {
        return {
          status: 200,
          headers: {
            'x-success': 'should-not-leak'
          },
          cookies: [
            {
              name: 'session',
              value: 'token',
              options: {
                sameSite: 'none'
              }
            }
          ],
          body: {
            ok: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/bad-modern-cookie');

    assert.equal(response.status, 500);
    assert.equal(response.headers['x-success'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });


  it('rejects invalid cookie max-age before writing success headers', async () => {
    let appCookieResponse = await responseForHandlerResult({
      status: 200,
      headers: {
        'x-success': 'should-not-leak'
      },
      cookies: [
        {
          name: 'session',
          value: 'token',
          options: {
            maxAge: true
          }
        }
      ],
      body: {
        ok: true
      }
    });
    let rawCookieResponse = await responseForHandlerResult({
      status: 200,
      headers: {
        'set-cookie': 'session=token; Max-Age=',
        'x-success': 'should-not-leak'
      },
      body: {
        ok: true
      }
    });

    assertInternalErrorResponse(appCookieResponse, {
      setCookie: true
    });
    assertInternalErrorResponse(rawCookieResponse, {
      setCookie: true
    });
  });



  it('rejects insecure raw Set-Cookie headers before writing success headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/bad-raw-cookie',
      handler() {
        return {
          status: 200,
          headers: {
            'set-cookie': 'session=token; SameSite=None',
            'x-success': 'should-not-leak'
          },
          body: {
            ok: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/bad-raw-cookie');

    assert.equal(response.status, 500);
    assert.equal(response.headers['x-success'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('rejects insecure raw Set-Cookie headers from Fetch Response results', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/bad-fetch-cookie',
      handler() {
        let headers = new Headers({
          'x-success': 'should-not-leak'
        });

        headers.append('set-cookie', '__Host-session=token; Secure; Path=/');
        headers.append('set-cookie', 'partitioned=token; Partitioned');

        return new Response('ok', {
          status: 200,
          headers
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/bad-fetch-cookie');

    assert.equal(response.status, 500);
    assert.equal(response.headers['x-success'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('lets rules stop a request with a normal endpoint response', async () => {
    let requireProject = defineRule('requireProject', ({ input }) => {
      if (input.params.slug !== 'signal-notes') {
        return {
          status: 404,
          body: {
            error: 'Project not found.'
          }
        };
      }
    });

    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      params: z.object({
        slug: z.string().min(1)
      }),
      responses: {
        200: z.object({
          success: z.literal(true)
        }),
        404: z.object({
          error: z.string()
        })
      },
      rules: [requireProject],
      async handler() {
        return ok({
          success: true
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/projects/unknown');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: 'Project not found.'
    });
  });



  it('serves HEAD requests through matching GET routes without a body', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .head('/health');

    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.text, undefined);
  });



  it('rejects duplicate raw cookie headers before cookies are parsed', async () => {
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
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: api.example.test',
      'Cookie: session=trusted',
      'Cookie: session=shadow',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Ambiguous cookie header"/);
    assert.equal(called, false);
  });



  it('applies handler response headers through HTTP', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cacheable',
      response: z.object({
        success: z.literal(true)
      }),
      async handler() {
        return {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=60',
            ETag: '"cacheable-v1"'
          },
          body: {
            success: true
          }
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/cacheable');

    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=60');
    assert.equal(response.headers.etag, '"cacheable-v1"');
    assert.deepEqual(response.body, {
      success: true
    });
  });



  it('allows explicit response content length when it matches the body', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/fixed-length',
      handler() {
        return {
          status: 200,
          headers: {
            'content-length': '5',
            'content-type': 'text/plain'
          },
          body: 'hello'
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/fixed-length');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-length'], '5');
    assert.equal(response.text, 'hello');
  });



  it('rejects Content-Range on non-range responses before writing success headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/download',
      handler() {
        return {
          status: 200,
          headers: {
            'Content-Range': 'bytes 0-4/11',
            'X-Success': 'should-not-leak'
          },
          body: 'hello world'
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/download');

    assert.equal(response.status, 500);
    assert.equal(response.headers['content-range'], undefined);
    assert.equal(response.headers['x-success'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('rejects partial content responses without range framing', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/download',
      handler() {
        return {
          status: 206,
          headers: {
            'Content-Type': 'text/plain',
            'X-Success': 'should-not-leak'
          },
          body: 'hello'
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/download')
      .set('Range', 'bytes=0-4');

    assert.equal(response.status, 500);
    assert.equal(response.headers['x-success'], undefined);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });



  it('allows app-owned partial content responses with Content-Range', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/download',
      handler() {
        return {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-4/11',
            'Content-Type': 'text/plain'
          },
          body: 'hello'
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/download')
      .set('Range', 'bytes=0-4');

    assert.equal(response.status, 206);
    assert.equal(response.headers['content-range'], 'bytes 0-4/11');
    assert.equal(response.text, 'hello');
  });



  it('returns not modified for matching ETag validators', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cacheable',
      handler() {
        return {
          status: 200,
          headers: {
            ETag: '"cacheable-v1"',
            'Cache-Control': 'public, max-age=60'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/cacheable')
      .set('if-none-match', '"other", "cacheable-v1"');

    assert.equal(response.status, 304);
    assert.equal(response.headers.etag, '"cacheable-v1"');
    assert.equal(response.headers['cache-control'], 'public, max-age=60');
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.text, '');
  });



  it('uses weak ETag comparison for If-None-Match validators', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cacheable',
      handler() {
        return {
          status: 200,
          headers: {
            ETag: 'W/"cacheable-v1"'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/cacheable')
      .set('if-none-match', '"cacheable-v1"');

    assert.equal(response.status, 304);
    assert.equal(response.headers.etag, 'W/"cacheable-v1"');
    assert.equal(response.text, '');
  });



  it('returns not modified for matching Last-Modified validators', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cacheable-by-date',
      handler() {
        return {
          status: 200,
          headers: {
            'Last-Modified': 'Sun, 14 Jun 2026 10:00:00 GMT'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/cacheable-by-date')
      .set('if-modified-since', 'Sun, 14 Jun 2026 10:30:00 GMT');

    assert.equal(response.status, 304);
    assert.equal(response.headers['last-modified'], 'Sun, 14 Jun 2026 10:00:00 GMT');
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(response.text, '');
  });



  it('applies handler response cookies through HTTP', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/sessions',
      response: z.object({
        success: z.literal(true)
      }),
      async handler() {
        return {
          status: 201,
          cookies: [
            {
              name: 'accessToken',
              value: 'signed-token',
              options: {
                httpOnly: true,
                sameSite: 'lax'
              }
            }
          ],
          body: {
            success: true
          }
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/sessions');

    assert.equal(response.status, 201);
    assert.match(response.headers['set-cookie'][0], /accessToken=signed-token/);
    assert.match(response.headers['set-cookie'][0], /httponly/i);
    assert.match(response.headers['set-cookie'][0], /path=\//i);
    assert.match(response.headers['set-cookie'][0], /samesite=lax/i);
    assert.deepEqual(response.body, {
      success: true
    });
  });



  it('serializes modern secure cookie attributes through HTTP', async () => {
    let expires = new Date('2030-01-01T00:00:00.000Z');
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/sessions/modern',
      response: z.object({
        success: z.literal(true)
      }),
      async handler() {
        return {
          status: 201,
          cookies: [
            {
              name: '__Host-session',
              value: 'signed-token',
              options: {
                expires,
                httpOnly: true,
                maxAge: 3600,
                partitioned: true,
                priority: 'high',
                sameSite: 'none',
                secure: true
              }
            }
          ],
          body: {
            success: true
          }
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/sessions/modern');
    let cookie = response.headers['set-cookie'][0];

    assert.equal(response.status, 201);
    assert.match(cookie, /__Host-session=signed-token/);
    assert.match(cookie, /Max-Age=3600/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Expires=Tue, 01 Jan 2030 00:00:00 GMT/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Partitioned/);
    assert.match(cookie, /Priority=High/);
    assert.deepEqual(response.body, {
      success: true
    });
  });



  it('exposes request cookies to endpoint handlers through HTTP', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/sessions/refresh',
      response: z.object({
        refreshToken: z.string()
      }),
      async handler({ request }) {
        return {
          status: 200,
          body: {
            refreshToken: request.cookies.refreshToken
          }
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/sessions/refresh')
      .set('Cookie', ['refreshToken=refresh-token-123']);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      refreshToken: 'refresh-token-123'
    });
  });



  it('applies handler redirects through HTTP', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/verify-email',
      async handler() {
        return {
          status: 303,
          redirect: '/login?verified=true'
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/verify-email');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login?verified=true');
  });



  it('defaults redirects to 303 when no redirect status is provided', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/verify-email',
      async handler() {
        return {
          redirect: '/login?verified=true'
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/verify-email');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login?verified=true');
  });



  it('allows redirects from endpoints with success response schemas', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/email-links/:token',
      response: z.object({
        success: z.literal(true)
      }),
      handler() {
        return {
          redirect: '/login?verified=true'
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/email-links/signed-token');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login?verified=true');
    assert.equal(response.body.error, undefined);
  });



  it('strips entity headers from bodyless redirects', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/redirect-with-body',
      handler() {
        return {
          redirect: '/sessions/new',
          body: {
            ignored: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/redirect-with-body');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/sessions/new');
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(response.text, '');
  });



  it('does not write a response body for HEAD requests', async () => {
    let endpoint = defineEndpoint({
      method: 'head',
      path: '/cacheable',
      handler() {
        return {
          status: 200,
          headers: {
            'x-cache-state': 'fresh'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .head('/cacheable');

    assert.equal(response.status, 200);
    assert.equal(response.headers['x-cache-state'], 'fresh');
    assert.equal(response.headers['content-length'], '16');
    assert.equal(response.text, undefined);
  });



  it('closes ignored stream bodies for HEAD requests', async () => {
    let cleanedUp = false;
    let endpoint = defineEndpoint({
      method: 'head',
      path: '/events',
      handler() {
        return {
          status: 200,
          body: Readable.from(['data: ignored\n\n']),
          onClose() {
            cleanedUp = true;
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .head('/events');

    assert.equal(response.status, 200);
    assert.equal(response.text, undefined);
    assert.equal(cleanedUp, true);
  });



  it('cancels ignored web stream bodies for HEAD requests', async () => {
    let canceled = false;
    let endpoint = defineEndpoint({
      method: 'head',
      path: '/web-events',
      handler() {
        return {
          status: 200,
          body: new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('data: ignored\n\n'));
            },
            cancel() {
              canceled = true;
            }
          })
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .head('/web-events');

    assert.equal(response.status, 200);
    assert.equal(response.text, undefined);
    assert.equal(canceled, true);
  });



  it('removes entity headers from 204 responses', async () => {
    let endpoint = defineEndpoint({
      method: 'delete',
      path: '/sessions/current',
      handler() {
        return {
          status: 204,
          headers: {
            'Content-Length': '16',
            'Content-Type': 'application/json'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .delete('/sessions/current');

    assert.equal(response.status, 204);
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(response.text, '');
  });



  it('removes entity headers from 205 responses', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/form/reset',
      handler() {
        return {
          status: 205,
          headers: {
            'Content-Length': '16',
            'Content-Type': 'application/json'
          },
          body: {
            success: true
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/form/reset');

    assert.equal(response.status, 205);
    assert.equal(response.headers['content-length'], undefined);
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(response.text, '');
  });



  it('serves streamed endpoint bodies and runs cleanup when the stream closes', async () => {
    let cleanedUp = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events',
      async handler() {
        return {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream'
          },
          body: Readable.from(['event: snapshot\n', 'data: {"ok":true}\n\n']),
          onClose() {
            cleanedUp = true;
          }
        };
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/events')
      .expect(200);

    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.equal(response.text, 'event: snapshot\ndata: {"ok":true}\n\n');
    assert.equal(cleanedUp, true);
  });



  it('serves Fetch Response handler results without JSON mangling', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/fetch-response',
      handler() {
        return new Response('created from fetch response', {
          status: 201,
          headers: {
            'content-type': 'text/plain',
            'x-response-source': 'fetch'
          }
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/fetch-response');

    assert.equal(response.status, 201);
    assert.equal(response.headers['content-type'], 'text/plain');
    assert.equal(response.headers['x-response-source'], 'fetch');
    assert.equal(response.text, 'created from fetch response');
  });



  it('preserves multiple Set-Cookie headers from Fetch Response results', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/sessions/fetch',
      handler() {
        let headers = new Headers({
          'content-type': 'text/plain'
        });

        headers.append('set-cookie', 'accessToken=signed-token; HttpOnly; Path=/');
        headers.append('set-cookie', 'refreshToken=signed-refresh; HttpOnly; Path=/');

        return new Response('created from fetch response', {
          status: 201,
          headers
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/sessions/fetch');

    assert.equal(response.status, 201);
    assert.equal(response.headers['content-type'], 'text/plain');
    assert.deepEqual(response.headers['set-cookie'], [
      'accessToken=signed-token; HttpOnly; Path=/',
      'refreshToken=signed-refresh; HttpOnly; Path=/'
    ]);
  });



  it('serves web ReadableStream response bodies', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/web-stream',
      handler() {
        return {
          status: 200,
          headers: {
            'Content-Type': 'text/plain'
          },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first\n'));
              controller.enqueue(new TextEncoder().encode('second\n'));
              controller.close();
            }
          })
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/web-stream');

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/plain');
    assert.equal(response.text, 'first\nsecond\n');
  });



  it('keeps cleanup failures from escaping response close events', async () => {
    let cleanupAttempts = 0;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cleanup-fails',
      handler() {
        return {
          status: 200,
          body: {
            ok: true
          },
          onClose() {
            cleanupAttempts += 1;
            throw new Error('cleanup failed');
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let first = await request(app)
      .get('/cleanup-fails');
    let second = await request(app)
      .get('/cleanup-fails');

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { ok: true });
    assert.equal(cleanupAttempts, 2);
  });



  it('writes binary response bodies without JSON serialization', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/export',
      handler() {
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream'
          },
          body: new Uint8Array([65, 66, 67])
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/export');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, Buffer.from('ABC'));
  });



  it('runs response cleanup for redirects', async () => {
    let cleanedUp = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/login',
      handler() {
        return {
          status: 303,
          redirect: '/sessions/new',
          onClose() {
            cleanedUp = true;
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/login');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/sessions/new');
    assert.equal(cleanedUp, true);
  });


  it('uses If-None-Match precedence over If-Modified-Since validators', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/cacheable',
      handler() {
        return {
          status: 200,
          headers: {
            ETag: '"cacheable-v2"',
            'Last-Modified': 'Sun, 14 Jun 2026 10:00:00 GMT'
          },
          body: {
            version: 2
          }
        };
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/cacheable')
      .set('if-none-match', '"cacheable-v1"')
      .set('if-modified-since', 'Sun, 14 Jun 2026 10:30:00 GMT');

    assert.equal(response.status, 200);
    assert.equal(response.headers.etag, '"cacheable-v2"');
    assert.deepEqual(response.body, { version: 2 });
  });


});
