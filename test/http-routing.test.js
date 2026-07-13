import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import {
  createCricketRuntime,
  deprecateEndpoint,
  defineEndpoint,
  defineRule,
  ok,
  respond,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import {
  createHttpApp,
  rawHttpResponse
} from './fixtures/http.js';

function healthEndpoint(path = '/health') {
  return defineEndpoint({
    method: 'get',
    path,
    handler: () => ok({ success: true })
  });
}

describe('Cricket HTTP routing', () => {
  it('threads rule facts, route params, and app context to handlers', async () => {
    let loadProject = defineRule('loadProject', ({ input }) => {
      return {
        project: {
          slug: input.params.slug,
          name: 'Signal Notes'
        }
      };
    });
    let loadPermissions = defineRule('loadPermissions', ({ project }) => {
      return {
        permissions: [`read:${project.slug}`]
      };
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      params: z.object({
        slug: z.string().min(1)
      }),
      rules: [
        loadProject,
        loadPermissions
      ],
      handler({ input, permissions, project, request: cricketRequest, user }) {
        return ok({
          inputSlug: input.params.slug,
          requestSlug: cricketRequest.params.slug,
          permissions,
          project,
          userId: user.id
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request: cricketRequest }) {
        return {
          user: cricketRequest.headers.authorization ? { id: 'user_123' } : undefined
        };
      }
    });
    let response = await request(app)
      .get('/projects/signal-notes')
      .set('authorization', 'Bearer token');

    assert.deepEqual(response.body, {
      inputSlug: 'signal-notes',
      requestSlug: 'signal-notes',
      permissions: ['read:signal-notes'],
      project: {
        slug: 'signal-notes',
        name: 'Signal Notes'
      },
      userId: 'user_123'
    });
  });

  it('lets middleware stop malformed bodies before Cricket reads them', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/projects',
      body: z.object({
        name: z.string()
      }),
      handler: () => ok({ success: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      middleware: [
        async requestContext => respond(401, {
            error: 'Sign in first'
        })
      ]
    });
    let response = await request(app)
      .post('/projects')
      .type('json')
      .send('{"name"');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: 'Sign in first'
    });
  });

  it('treats transport-shaped middleware and fallback values as bodies', async () => {
    let middlewareApp = await createHttpApp({
      endpoints: [healthEndpoint()],
      middleware: [
        async () => ({
          status: 401,
          body: {
            source: 'middleware'
          }
        })
      ]
    });
    let fallbackApp = await createHttpApp({
      endpoints: [],
      fallback() {
        return {
          status: 404,
          redirect: '/not-a-redirect',
          body: {
            source: 'fallback'
          }
        };
      }
    });
    let middlewareResponse = await request(middlewareApp)
      .get('/health');
    let fallbackResponse = await request(fallbackApp)
      .get('/missing');

    assert.equal(middlewareResponse.status, 200);
    assert.deepEqual(middlewareResponse.body, {
      status: 401,
      body: {
        source: 'middleware'
      }
    });
    assert.equal(fallbackResponse.status, 200);
    assert.equal(fallbackResponse.headers.location, undefined);
    assert.deepEqual(fallbackResponse.body, {
      status: 404,
      redirect: '/not-a-redirect',
      body: {
        source: 'fallback'
      }
    });
  });

  it('routes after middleware rewrites request data', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects/:slug',
      handler({ input, contextSlug }) {
        return ok({
          contextSlug,
          inputSlug: input.params.slug
        });
      }
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      context({ request: cricketRequest }) {
        return {
          contextSlug: cricketRequest.params.slug
        };
      },
      middleware: [
        async (requestContext, next) => await next({
          ...requestContext,
          request: {
            ...requestContext.request,
            path: '/projects/signal-notes'
          }
        })
      ]
    });
    let response = await request(app)
      .get('/legacy/signal-notes');

    assert.deepEqual(response.body, {
      contextSlug: 'signal-notes',
      inputSlug: 'signal-notes'
    });
  });

  it('matches literal and parameter routes predictably', async () => {
    let endpoints = [
      defineEndpoint({
        method: 'get',
        path: '/files/:name.json',
        handler: ({ input }) => ok({ name: input.params.name })
      }),
      defineEndpoint({
        method: 'get',
        path: '/users/:id',
        handler: ({ input }) => ok({ route: 'id', id: input.params.id })
      }),
      defineEndpoint({
        method: 'get',
        path: '/users/me',
        handler: () => ok({ route: 'me' })
      })
    ];
    let app = await createHttpApp({
      endpoints
    });
    let file = await request(app).get('/files/report.json');
    let user = await request(app).get('/users/me');

    assert.deepEqual(file.body, { name: 'report' });
    assert.deepEqual(user.body, { route: 'me' });
  });

  it('returns Allow headers for OPTIONS and method mismatches', async () => {
    let app = await createHttpApp({
      endpoints: [healthEndpoint()]
    });
    let options = await request(app).options('/health');
    let blocked = await request(app).post('/health');
    let asterisk = await rawHttpResponse(app, [
      'OPTIONS * HTTP/1.1',
      'Host: api.example.test',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));

    assert.equal(options.status, 204);
    assert.equal(options.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal(blocked.status, 405);
    assert.equal(blocked.headers.allow, 'GET, HEAD, OPTIONS');
    assert.match(asterisk, /^HTTP\/1\.1 204 /);
    assert.match(asterisk, /Allow: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT/i);
  });

  for (let method of ['TRACE', 'PROPFIND']) {
    it(`rejects unsupported ${method} before middleware or handlers run`, async () => {
      let called = false;
      let app = await createHttpApp({
        endpoints: [healthEndpoint()],
        fallback() {
          called = true;
          return ok({ success: true });
        },
        middleware: [
          async (requestContext, next) => {
            called = true;
            return await next(requestContext);
          }
        ]
      });
      let response = await rawHttpResponse(app, [
        `${method} /health HTTP/1.1`,
        'Host: api.example.test',
        'Connection: close',
        '',
        ''
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 405 /);
      assert.equal(called, false);
    });
  }

  for (let target of [
    '/files/%E0%A4%A',
    '/files/private%2Favatar.png',
    '/files/private%5Cavatar.png',
    '/files/%00avatar.png'
  ]) {
    it(`rejects unsafe path parameter target ${target}`, async () => {
      let app = await createHttpApp({
        endpoints: [
          defineEndpoint({
            method: 'get',
            path: '/files/:name',
            handler: ({ input }) => ok({ name: input.params.name })
          })
        ]
      });
      let response = await request(app)
        .get(target);

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'BAD_REQUEST');
    });
  }

  it('uses app fallbacks only after routing misses', async () => {
    let app = await createHttpApp({
      endpoints: [],
      context() {
        return {
          appName: 'Project API'
        };
      },
      fallback({ appName, request: cricketRequest }) {
        return respond(404, {
            path: cricketRequest.path
        });
      }
    });
    let response = await request(app)
      .get('/missing');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      path: '/missing'
    });
  });

  it('derives request origin from direct and trusted proxy requests', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/where-am-i',
      handler({ request: cricketRequest }) {
        return ok({
          origin: cricketRequest.origin,
          protocol: cricketRequest.protocol,
          host: cricketRequest.host,
          secure: cricketRequest.secure
        });
      }
    });
    let directApp = await createHttpApp({
      endpoints: [endpoint]
    });
    let trustedApp = await createHttpApp({
      endpoints: [endpoint],
      trustProxy: true
    });
    let direct = await request(directApp)
      .get('/where-am-i')
      .set('host', 'api.example.test');
    let forwarded = await request(trustedApp)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'api.example.test')
      .set('x-forwarded-proto', 'https');

    assert.deepEqual(direct.body, {
      origin: 'http://api.example.test',
      protocol: 'http',
      host: 'api.example.test',
      secure: false
    });
    assert.equal(forwarded.body.origin, 'https://api.example.test');
    assert.equal(forwarded.body.secure, true);
  });

  it('ignores proxy headers unless trustProxy is enabled', async () => {
    let app = await createHttpApp({
      endpoints: [
        defineEndpoint({
          method: 'get',
          path: '/where-am-i',
          handler: ({ request: cricketRequest }) => ok({
            origin: cricketRequest.origin,
            secure: cricketRequest.secure
          })
        })
      ]
    });
    let response = await request(app)
      .get('/where-am-i')
      .set('host', 'internal.example.test')
      .set('x-forwarded-host', 'api.example.test')
      .set('x-forwarded-proto', 'https');

    assert.deepEqual(response.body, {
      origin: 'http://internal.example.test',
      secure: false
    });
  });

  for (let target of [
    'session',
    '//evil.example.test/session',
    '/api/%2e%2e/session',
    '/api/../session',
    'https://api.example.test/session'
  ]) {
    it(`rejects route-confusing request target ${target}`, async () => {
      let called = false;
      let app = await createHttpApp({
        allowedHosts: ['api.example.test'],
        endpoints: [
          defineEndpoint({
            method: 'get',
            path: '/session',
            handler() {
              called = true;
              return ok({ success: true });
            }
          })
        ]
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

  for (let scenario of [
    {
      name: 'host outside allow-list',
      request: request => request.set('host', 'evil.example.test'),
      options: { allowedHosts: ['api.example.test'] },
      message: 'Host not allowed'
    },
    {
      name: 'invalid forwarded host syntax',
      request: request => request
        .set('x-forwarded-host', 'api.example.test/path')
        .set('x-forwarded-proto', 'https'),
      options: { trustProxy: true },
      message: 'Invalid Host header'
    },
    {
      name: 'invalid host port',
      request: request => request.set('host', 'api.example.test:99999'),
      options: {},
      message: 'Invalid Host header'
    }
  ]) {
    it(`rejects ${scenario.name}`, async () => {
      let app = await createHttpApp({
        endpoints: [healthEndpoint('/session')],
        ...scenario.options
      });
      let response = await scenario.request(request(app).get('/session'));

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'BAD_REQUEST');
      assert.equal(response.body.error.message, scenario.message);
    });
  }

  for (let scenario of [
    {
      name: 'duplicate Host',
      lines: ['Host: api.example.test', 'Host: evil.example.test'],
      message: 'Ambiguous host header'
    },
    {
      name: 'duplicate Authorization',
      lines: ['Authorization: Bearer trusted', 'Authorization: Bearer shadow'],
      message: 'Ambiguous authorization header'
    }
  ]) {
    it(`rejects ${scenario.name} before middleware runs`, async () => {
      let called = false;
      let app = await createHttpApp({
        endpoints: [healthEndpoint('/session')],
        trustProxy: true,
        middleware: [
          async (requestContext, next) => {
            called = true;
            return await next(requestContext);
          }
        ]
      });
      let response = await rawHttpResponse(app, [
        'GET /session HTTP/1.1',
        'Host: api.example.test',
        ...scenario.lines,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));

      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, new RegExp(`"message":"${scenario.message}"`, 'i'));
      assert.equal(called, false);
    });
  }

  it('supports stateful allowed host regexes without cross-request drift', async () => {
    let app = await createHttpApp({
      allowedHosts: [/^api\.example\.test$/g],
      endpoints: [healthEndpoint('/session')]
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

  it('keeps framework context fields authoritative while merging app context', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/context',
      handler({ logger, request: cricketRequest, services }) {
        return ok({
          hasLogger: Boolean(logger),
          requestPath: cricketRequest.path,
          serviceName: services.example.name
        });
      }
    });
    let app = await createHttpApp({
      name: 'Project API',
      endpoints: [endpoint],
      services: {
        example: { name: 'example' }
      },
      context() {
        return {
          app: 'cannot override',
          logger: 'cannot override',
          request: 'cannot override',
          services: 'cannot override'
        };
      }
    });
    let response = await request(app)
      .get('/context');

    assert.deepEqual(response.body, {
      hasLogger: true,
      requestPath: '/context',
      serviceName: 'example'
    });
  });

  it('rejects unsupported endpoint methods and duplicate routes at load time', async () => {
    assert.throws(() => defineEndpoint({
      method: 'trace',
      path: '/health',
      handler: () => ok({ success: true })
    }), /Unsupported endpoint method TRACE/);

    let endpoint = healthEndpoint('/health');

    await assert.rejects(
      createCricketRuntime(defineManualTestApp({
        endpoints: [endpoint, endpoint]
      })),
      /Duplicate route GET \/health/
    );
  });

  it('rejects unsupported endpoint options at definition time', () => {
    assert.throws(() => defineEndpoint({
      method: 'get',
      path: '/session',
      auth: true,
      handler: () => ok({ success: true })
    }), /Unsupported endpoint option auth/);

    assert.throws(() => defineEndpoint({
      method: 'post',
      path: '/uploads',
      middleware: [],
      handler: () => ok({ success: true })
    }), /Unsupported endpoint option middleware/);

    assert.throws(() => defineEndpoint({
      method: 'get',
      path: '/ok',
      traceName: true,
      handler: () => ok({ success: true })
    }), /GET \/ok traceName must be a string/);

    assert.throws(() => defineEndpoint({
      method: 'get',
      path: '/deprecated',
      deprecation: {
        reason: 'Use the new route.'
      },
      handler: () => ok({ success: true })
    }), /Unsupported endpoint option deprecation/);

    assert.throws(() => deprecateEndpoint(healthEndpoint('/old-health'), {
      headers: 'yes'
    }), /Endpoint deprecation headers must be a boolean/);
  });

  it('rejects unsupported app options at definition time', () => {
    assert.throws(() => defineManualTestApp({
      midleware: []
    }), /defineCricketApp received unknown option midleware/);
  });

  it('composes deprecation metadata around normal endpoint behavior', async () => {
    let endpoint = deprecateEndpoint(defineEndpoint({
      method: 'get',
      path: '/old-health',
      handler: () => ok({ success: true })
    }), {
      since: '2026-06-17',
      replacement: 'GET /health',
      reason: 'Use the health endpoint.'
    });
    let app = await createHttpApp({
      endpoints: [endpoint]
    });

    let response = await request(app)
      .get('/old-health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true });
    assert.deepEqual(endpoint.deprecation, {
      since: '2026-06-17',
      replacement: 'GET /health',
      reason: 'Use the health endpoint.'
    });
  });
});
