import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';

import {
  created,
  createCricketRuntime,
  defineCricketApp,
  defineEndpoint,
  defineRouteGroup,
  defineRule,
  ok,
  z
} from '../src/index.js';
import {
  createHttpApp,
  rawHttpResponse
} from './fixtures/http.js';

describe('Cricket HTTP routing', () => {
  it('shares request state from rules to handlers through HTTP', async () => {
    let loadProject = defineRule('loadProject', ({ input, state }) => {
      state.project = {
        slug: input.params.slug,
        name: 'Signal Notes'
      };
    });

    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      params: z.object({
        slug: z.string().min(1)
      }),
      response: z.object({
        success: z.literal(true),
        project: z.object({
          slug: z.string(),
          name: z.string()
        })
      }),
      rules: [loadProject],
      async handler({ state }) {
        return ok({
          success: true,
          project: state.project
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
      success: true,
      project: {
        slug: 'signal-notes',
        name: 'Signal Notes'
      }
    });
  });


  it('runs endpoint exchange hooks before Cricket handles the request', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/imports',
      before: [
        async (exchange, next) => {
          return await next({
            ...exchange,
            context: {
              ...exchange.context,
              importSource: {
                name: exchange.request.headers['x-import-source']
              }
            }
          });
        }
      ],
      response: z.object({
        success: z.literal(true),
        source: z.string()
      }),
      async handler({ importSource }) {
        return ok({
          success: true,
          source: importSource.name
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/imports')
      .set('x-import-source', 'csv');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      success: true,
      source: 'csv'
    });
  });


  it('lets endpoint exchange hooks stop before Cricket reads the body', async () => {
    let handled = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      before: [
        async () => {
          return {
            status: 403,
            body: {
              error: {
                code: 'FORBIDDEN',
                message: 'Uploads are closed'
              }
            }
          };
        }
      ],
      handler() {
        handled = true;
        return ok({
          success: true
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .post('/uploads')
      .set('content-type', 'application/json')
      .send('{not json');

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: {
        code: 'FORBIDDEN',
        message: 'Uploads are closed'
      }
    });
    assert.equal(handled, false);
  });


  it('checks endpoint auth before endpoint exchange hooks can stop the request', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/account',
      auth: true,
      before: [
        async () => ok({
          bypassed: true
        })
      ],
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
      .get('/account');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Unauthenticated'
      }
    });
  });


  it('composes route groups and app exchange hooks through HTTP', async () => {
    let apiRoutes = defineRouteGroup('/projects')
      .use(async (exchange, next) => {
        return await next({
          ...exchange,
          context: {
            ...exchange.context,
            groupName: 'projects'
          }
        });
      })
      .post('/', {
        body: z.object({
          name: z.string()
        }).strict(),
        response: z.object({
          requestId: z.string(),
          groupName: z.string(),
          project: z.object({
            name: z.string()
          })
        }),
        handler({ groupName, input, requestId }) {
          return created({
            groupName,
            requestId,
            project: input.body
          });
        }
      });
    let app = await createHttpApp({
      prefix: '/api',
      endpoints: [apiRoutes],
      use: [
        async (exchange, next) => {
          return await next({
            ...exchange,
            context: {
              ...exchange.context,
              requestId: exchange.request.headers['x-request-id']
            }
          });
        }
      ]
    });

    let createdProject = await request(app)
      .post('/api/projects')
      .set('x-request-id', 'req_123')
      .send({ name: 'Signal Notes' });
    let invalidProject = await request(app)
      .post('/api/projects')
      .send({
        name: 'Signal Notes',
        unexpected: true
      });

    assert.equal(createdProject.status, 201);
    assert.deepEqual(createdProject.body, {
      groupName: 'projects',
      requestId: 'req_123',
      project: {
        name: 'Signal Notes'
      }
    });
    assert.equal(invalidProject.status, 422);
    assert.equal(invalidProject.body.error.code, 'VALIDATION_FAILED');
  });


  it('treats route groups as immutable route values', async () => {
    let baseGroup = defineRouteGroup('/projects');
    let groupWithHook = baseGroup.use(async (exchange, next) => {
      return await next({
        ...exchange,
        context: {
          ...exchange.context,
          groupName: 'projects'
        }
      });
    });
    let groupWithRoute = groupWithHook.get('/:slug', {
      response: z.object({
        groupName: z.string(),
        slug: z.string()
      }),
      handler({ groupName, request }) {
        return ok({
          groupName,
          slug: request.params.slug
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [
        baseGroup,
        groupWithRoute
      ]
    });

    let response = await request(app)
      .get('/projects/signal-notes');

    assert.equal(baseGroup.endpoints.length, 0);
    assert.equal(groupWithHook.endpoints.length, 0);
    assert.equal(groupWithRoute.endpoints.length, 1);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      groupName: 'projects',
      slug: 'signal-notes'
    });
  });


  it('lets app exchange hooks stop malformed bodies before Cricket reads them', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/projects',
      body: z.object({
        name: z.string()
      }),
      handler: () => created({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      use: [
        async exchange => {
          if (!exchange.request.headers.authorization) {
            return {
              status: 401,
              body: {
                error: 'Sign in first'
              }
            };
          }

          return {
            status: 500,
            body: {
              error: 'unreachable'
            }
          };
        }
      ]
    });

    let response = await request(app)
      .post('/projects')
      .set('content-type', 'application/json')
      .send('{"name"');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: 'Sign in first'
    });
  });


  it('rematches routes and context after app exchange hooks rewrite the request', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      response: z.object({
        contextSlug: z.string(),
        inputSlug: z.string()
      }),
      handler({ contextSlug, input }) {
        return ok({
          contextSlug,
          inputSlug: input.params.slug
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        return {
          contextSlug: request.params.slug
        };
      },
      use: [
        async (exchange, next) => {
          return await next({
            ...exchange,
            request: {
              ...exchange.request,
              path: '/projects/signal-notes'
            }
          });
        }
      ]
    });

    let response = await request(app)
      .get('/legacy/signal-notes');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      contextSlug: 'signal-notes',
      inputSlug: 'signal-notes'
    });
  });


  it('treats route path punctuation as literal text', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/files/:name.json',
      response: z.object({
        name: z.string()
      }),
      handler({ input }) {
        return ok({
          name: input.params.name
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let found = await request(app)
      .get('/files/report.json');
    let missing = await request(app)
      .get('/files/report-json');

    assert.equal(found.status, 200);
    assert.deepEqual(found.body, {
      name: 'report'
    });
    assert.equal(missing.status, 404);
  });


  it('matches literal routes before parameter routes', async () => {
    let userById = defineEndpoint({
      method: 'get',
      path: '/users/:id',
      handler({ input }) {
        return ok({
          route: 'id',
          id: input.params.id
        });
      }
    });
    let currentUser = defineEndpoint({
      method: 'get',
      path: '/users/me',
      handler() {
        return ok({
          route: 'me'
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [userById, currentUser]
    });

    let response = await request(app)
      .get('/users/me');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      route: 'me'
    });
  });


  it('returns Allow headers for OPTIONS and method mismatches', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let options = await request(app)
      .options('/health');
    let blocked = await request(app)
      .post('/health');

    assert.equal(options.status, 204);
    assert.equal(options.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal(blocked.status, 405);
    assert.equal(blocked.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal(blocked.body.error.code, 'METHOD_NOT_ALLOWED');
  });


  it('rejects TRACE before app hooks or route handlers can observe it', async () => {
    let hookCalled = false;
    let handlerCalled = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        handlerCalled = true;
        return ok({ success: true });
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
      'TRACE /health HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 405 Method Not Allowed/);
    assert.match(response, /Allow: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT/i);
    assert.match(response, /"code":"METHOD_NOT_ALLOWED"/);
    assert.equal(hookCalled, false);
    assert.equal(handlerCalled, false);
  });


  it('rejects unsupported methods before app hooks or fallbacks can observe them', async () => {
    let hookCalled = false;
    let fallbackCalled = false;
    let app = await createHttpApp({
      endpoints: [],
      use: [
        async (exchange, next) => {
          hookCalled = true;
          return await next(exchange);
        }
      ],
      fallback() {
        fallbackCalled = true;
        return ok({ success: true });
      }
    });
    let response = await rawHttpResponse(app, [
      'PROPFIND /dashboard HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 405 Method Not Allowed/);
    assert.match(response, /Allow: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT/i);
    assert.match(response, /"code":"METHOD_NOT_ALLOWED"/);
    assert.equal(hookCalled, false);
    assert.equal(fallbackCalled, false);
  });


  it('answers server-wide OPTIONS asterisk requests before app hooks run', async () => {
    let hookCalled = false;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ success: true })
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
      'OPTIONS * HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 204 /);
    assert.match(response, /Allow: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT/i);
    assert.equal(hookCalled, false);
  });


  it('rejects malformed path parameter encoding as a bad request', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/files/:name',
      handler({ input }) {
        return ok({
          name: input.params.name
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/files/%E0%A4%A');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Invalid path parameter encoding');
  });


  it('rejects encoded path delimiters inside route parameters', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/files/:name',
      handler({ input }) {
        return ok({
          name: input.params.name
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let encodedSlash = await request(app)
      .get('/files/private%2Favatar.png');
    let encodedBackslash = await request(app)
      .get('/files/private%5Cavatar.png');
    let encodedNull = await request(app)
      .get('/files/private%00avatar.png');

    assert.equal(encodedSlash.status, 400);
    assert.equal(encodedSlash.body.error.message, 'Invalid path parameter encoding');
    assert.equal(encodedBackslash.status, 400);
    assert.equal(encodedBackslash.body.error.message, 'Invalid path parameter encoding');
    assert.equal(encodedNull.status, 400);
    assert.equal(encodedNull.body.error.message, 'Invalid path parameter encoding');
  });


  it('falls through to the Cricket fallback when no endpoint matches', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/api/health',
      handler: () => ok({ ok: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      fallback({ request }) {
        return ok({
          fallback: request.path
        });
      }
    });

    let health = await request(app)
      .get('/api/health');
    let fallback = await request(app)
      .get('/dashboard');

    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, { fallback: '/dashboard' });
  });


  it('passes app context to the Cricket fallback', async () => {
    let app = await createHttpApp({
      endpoints: [],
      context({ request }) {
        return {
          fallbackPath: request.path
        };
      },
      fallback({ context }) {
        return ok({
          fallbackPath: context.fallbackPath
        });
      }
    });

    let response = await request(app)
      .get('/dashboard');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      fallbackPath: '/dashboard'
    });
  });


  it('exposes request origin as plain request data', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where',
      response: z.object({
        origin: z.string(),
        protocol: z.string(),
        host: z.string()
      }),
      async handler({ request }) {
        return ok({
          origin: request.origin,
          protocol: request.protocol,
          host: request.host
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/where')
      .set('host', 'api.example.test');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      origin: 'http://api.example.test',
      protocol: 'http',
      host: 'api.example.test'
    });
  });


  it('derives secure request data from trusted reverse proxy headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      response: z.object({
        origin: z.string(),
        protocol: z.string(),
        host: z.string(),
        secure: z.boolean()
      }),
      handler({ request }) {
        return ok({
          origin: request.origin,
          protocol: request.protocol,
          host: request.host,
          secure: request.secure
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'api.example.test')
      .set('x-forwarded-proto', 'https');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      origin: 'https://api.example.test',
      protocol: 'https',
      host: 'api.example.test',
      secure: true
    });
  });


  it('derives secure request data from standardized Forwarded headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      handler({ request }) {
        return ok({
          origin: request.origin,
          protocol: request.protocol,
          host: request.host,
          secure: request.secure
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('forwarded', 'for=192.0.2.10;proto=https;host="api.example.test"');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      origin: 'https://api.example.test',
      protocol: 'https',
      host: 'api.example.test',
      secure: true
    });
  });


  it('rejects conflicting standardized and legacy proxy headers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('forwarded', 'proto=https;host=api.example.test')
      .set('x-forwarded-host', 'evil.example.test');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Ambiguous x-forwarded-host header');
  });


  it('rejects ambiguous standardized Forwarded header chains', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('forwarded', 'proto=https;host=api.example.test, proto=http;host=evil.example.test');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Ambiguous Forwarded header');
  });


  it('ignores reverse proxy headers unless trustProxy is enabled', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      response: z.object({
        origin: z.string(),
        protocol: z.string(),
        host: z.string(),
        secure: z.boolean()
      }),
      handler({ request }) {
        return ok({
          origin: request.origin,
          protocol: request.protocol,
          host: request.host,
          secure: request.secure
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

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'api.example.test')
      .set('x-forwarded-proto', 'https');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      origin: 'http://internal.example.test',
      protocol: 'http',
      host: 'internal.example.test',
      secure: false
    });
  });


  it('rejects hosts outside the app allow-list', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      allowedHosts: ['api.example.test'],
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/session')
      .set('host', 'evil.example.test');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Host not allowed');
  });


  it('uses absolute-form request target authority for host allow-list checks', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: ({ request }) => ok({
        host: request.host,
        origin: request.origin,
        path: request.path,
        secure: request.secure
      })
    });
    let app = await createHttpApp({
      allowedHosts: ['api.example.test'],
      endpoints: [endpoint]
    });
    let accepted = await rawHttpResponse(app, [
      'GET https://api.example.test/session?from=target HTTP/1.1',
      'Host: evil.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    let rejected = await rawHttpResponse(app, [
      'GET https://evil.example.test/session HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(accepted, /^HTTP\/1\.1 200 /);
    assert.match(accepted, /"host":"api.example.test"/);
    assert.match(accepted, /"origin":"https:\/\/api.example.test"/);
    assert.match(accepted, /"path":"\/session"/);
    assert.match(accepted, /"secure":true/);
    assert.match(rejected, /^HTTP\/1\.1 400 /);
  });


  it('rejects non-origin request targets instead of normalizing them into paths', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET session HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });

  for (let target of [
    '//evil.example.test/session',
    '/api/%2e%2e/session',
    '/api/../session',
    'https://api.example.test/api/%2e%2e/session'
  ]) {
    it(`rejects route-confusing request target ${target}`, async () => {
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
        allowedHosts: ['api.example.test'],
        endpoints: [endpoint]
      });
      let response = await rawHttpResponse(app, [
        `GET ${target} HTTP/1.1`,
        'Host: api.example.test',
        'Connection: close',
        '',
        ''
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.equal(called, false);
    });
  }


  it('validates forwarded host syntax before building request origin', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/session')
      .set('x-forwarded-host', 'api.example.test/path')
      .set('x-forwarded-proto', 'https');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Invalid Host header');
  });


  it('rejects duplicate raw authority headers before origin is derived', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });
    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: api.example.test',
      'Host: evil.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });


  it('rejects duplicate raw authorization headers before context is built', async () => {
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
      context({ request }) {
        return {
          user: request.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });
    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: api.example.test',
      'Authorization: Bearer trusted',
      'Authorization: Bearer shadow',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Ambiguous authorization header"/);
    assert.equal(called, false);
  });


  it('rejects duplicate raw origin headers before app hooks run', async () => {
    let called = false;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/session',
      handler() {
        called = true;
        return ok({ success: true });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      use: [
        async (exchange, next) => {
          called = true;

          return await next(exchange);
        }
      ]
    });
    let response = await rawHttpResponse(app, [
      'POST /session HTTP/1.1',
      'Host: api.example.test',
      'Origin: https://trusted.example.test',
      'Origin: https://evil.example.test',
      'Content-Length: 0',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"code":"BAD_REQUEST"/);
    assert.match(response, /"message":"Ambiguous origin header"/);
    assert.equal(called, false);
  });

  for (let header of [
    {
      name: 'Referer',
      values: [
        'https://trusted.example.test/settings',
        'https://evil.example.test/settings'
      ],
      message: 'Ambiguous referer header'
    },
    {
      name: 'Access-Control-Request-Method',
      values: ['POST', 'DELETE'],
      message: 'Ambiguous access-control-request-method header'
    },
    {
      name: 'Sec-Fetch-Site',
      values: ['same-origin', 'cross-site'],
      message: 'Ambiguous sec-fetch-site header'
    }
  ]) {
    it(`rejects duplicate raw ${header.name} headers before app hooks run`, async () => {
      let called = false;
      let endpoint = defineEndpoint({
        method: 'options',
        path: '/session',
        handler() {
          called = true;
          return ok({ success: true });
        }
      });
      let app = await createHttpApp({
        endpoints: [endpoint],
        use: [
          async (exchange, next) => {
            called = true;

            return await next(exchange);
          }
        ]
      });
      let response = await rawHttpResponse(app, [
        'OPTIONS /session HTTP/1.1',
        'Host: api.example.test',
        `${header.name}: ${header.values[0]}`,
        `${header.name}: ${header.values[1]}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /"code":"BAD_REQUEST"/);
      assert.match(response, new RegExp(`"message":"${header.message}"`));
      assert.equal(called, false);
    });
  }

  for (let header of [
    {
      name: 'Origin',
      value: 'https://trusted.example.test, https://evil.example.test',
      message: 'Ambiguous origin header'
    },
    {
      name: 'Access-Control-Request-Method',
      value: 'POST, DELETE',
      message: 'Ambiguous access-control-request-method header'
    },
    {
      name: 'Sec-Fetch-Site',
      value: 'same-origin, cross-site',
      message: 'Ambiguous sec-fetch-site header'
    }
  ]) {
    it(`rejects comma-joined ${header.name} security metadata before app hooks run`, async () => {
      let called = false;
      let endpoint = defineEndpoint({
        method: 'options',
        path: '/session',
        handler() {
          called = true;
          return ok({ success: true });
        }
      });
      let app = await createHttpApp({
        endpoints: [endpoint],
        use: [
          async (exchange, next) => {
            called = true;

            return await next(exchange);
          }
        ]
      });
      let response = await rawHttpResponse(app, [
        'OPTIONS /session HTTP/1.1',
        'Host: api.example.test',
        `${header.name}: ${header.value}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /"code":"BAD_REQUEST"/);
      assert.match(response, new RegExp(`"message":"${header.message}"`));
      assert.equal(called, false);
    });
  }


  it('rejects hosts with invalid port ranges', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/session')
      .set('host', 'api.example.test:99999');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(response.body.error.message, 'Invalid Host header');
  });


  it('supports stateful allowed host regexes without cross-request drift', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      allowedHosts: [/^api\.example\.test$/g],
      endpoints: [endpoint]
    });

    let first = await request(app)
      .get('/session')
      .set('host', 'api.example.test');
    let second = await request(app)
      .get('/session')
      .set('host', 'api.example.test');

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });


  it('uses Cricket app context for endpoint auth data', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      response: z.object({
        userId: z.string(),
        role: z.string()
      }),
      async handler({ user, userId }) {
        return ok({
          userId,
          role: user.role
        });
      }
    });

    let app = await createHttpApp({
      endpoints: [endpoint],
      context() {
        let user = {
          userId: 'user_123',
          role: 'admin'
        };

        return {
          user,
          userId: user.userId
        };
      }
    });

    let response = await request(app)
      .get('/session');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      userId: 'user_123',
      role: 'admin'
    });
  });


  it('keeps framework context fields authoritative while merging app context', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/context',
      response: z.object({
        requestId: z.string(),
        serviceToken: z.string(),
        loggerReady: z.boolean(),
        stateFromHook: z.boolean(),
        stateFromContext: z.boolean()
      }),
      handler({ logger, requestId, services, state }) {
        return ok({
          requestId,
          serviceToken: services.token,
          loggerReady: typeof logger.info === 'function',
          stateFromHook: state.fromHook,
          stateFromContext: state.fromContext
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      setup() {
        return {
          services: {
            token: 'setup-service'
          }
        };
      },
      context() {
        return {
          logger: {
            info: 'not a logger'
          },
          requestId: 'request-123',
          services: {
            token: 'context-service'
          },
          state: {
            fromContext: true
          }
        };
      },
      use: [
        async (exchange, next) => {
          return await next({
            ...exchange,
            state: {
              fromHook: true
            }
          });
        }
      ]
    });

    let response = await request(app)
      .get('/context');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      requestId: 'request-123',
      serviceToken: 'setup-service',
      loggerReady: true,
      stateFromHook: true,
      stateFromContext: true
    });
  });


  it('resolves app context once with matched route params', async () => {
    let calls = 0;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      response: z.object({
        contextSlug: z.string()
      }),
      async handler({ contextSlug }) {
        return ok({
          contextSlug
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request }) {
        calls += 1;
        return {
          contextSlug: request.params.slug
        };
      }
    });

    let response = await request(app)
      .get('/projects/signal-notes');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      contextSlug: 'signal-notes'
    });
    assert.equal(calls, 1);
  });


  it('rejects unsupported endpoint methods at contract load time', async () => {
    assert.throws(
      () => defineEndpoint({
        method: 'trace',
        path: '/health',
        handler: () => ok({ success: true })
      }),
      /Unsupported endpoint method TRACE/
    );

    await assert.rejects(
      createCricketRuntime(defineCricketApp({
        endpoints: [
          {
            method: 'TRACE',
            path: '/health',
            async handle() {
              return ok({ success: true });
            }
          }
        ]
      })),
      /Unsupported endpoint method TRACE/
    );
  });


  it('rejects duplicate method and path routes', async () => {
    await assert.rejects(
      createCricketRuntime(defineCricketApp({
        endpoints: [
          defineEndpoint({
            method: 'get',
            path: '/projects',
            handler: () => ok({ first: true })
          }),
          defineEndpoint({
            method: 'get',
            path: '/projects/',
            handler: () => ok({ second: true })
          })
        ]
      })),
      /Duplicate route GET \/projects/
    );
  });


  it('rejects ambiguous forwarded header chains from trusted proxies', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let hostResponse = await request(app)
      .get('/session')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'evil.example.test, api.example.test')
      .set('x-forwarded-proto', 'https');
    let protoResponse = await request(app)
      .get('/session')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'api.example.test')
      .set('x-forwarded-proto', 'http, https');

    assert.equal(hostResponse.status, 400);
    assert.equal(hostResponse.body.error.message, 'Ambiguous x-forwarded-host header');
    assert.equal(protoResponse.status, 400);
    assert.equal(protoResponse.body.error.message, 'Ambiguous x-forwarded-proto header');
  });


  it('rejects duplicate raw forwarded headers from trusted proxies', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });
    let response = await rawHttpResponse(app, [
      'GET /session HTTP/1.1',
      'Host: internal.example.test',
      'X-Forwarded-Host: api.example.test',
      'X-Forwarded-Host: evil.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 400 /);
  });


  it('ignores unknown forwarded protocols from trusted proxies', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      response: z.object({
        origin: z.string(),
        protocol: z.string(),
        secure: z.boolean()
      }),
      handler({ request }) {
        return ok({
          origin: request.origin,
          protocol: request.protocol,
          secure: request.secure
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });

    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'api.example.test')
      .set('x-forwarded-proto', 'javascript');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      origin: 'http://api.example.test',
      protocol: 'http',
      secure: false
    });
  });


});
