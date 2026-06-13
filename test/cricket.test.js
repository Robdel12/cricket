import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import knex from 'knex';
import request from 'supertest';
import { z } from 'zod';

import {
  camelCaseKeys,
  collectEndpoints,
  collectModels,
  composeSerializers,
  created,
  createCricketKoaRuntime,
  createKnexRepository,
  createKoaApp,
  createServices,
  defineCricketApp,
  defineEndpoint,
  defineModel,
  defineRule,
  forbidden,
  fromKoaService,
  generateOpenApi,
  loadDomains,
  mapKeys,
  normalizeLogger,
  ok,
  pickFields,
  renameFields,
  startCricketApp
} from '../src/index.js';

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-'));
}

describe('Cricket', () => {
  it('validates input, applies rules, and serializes plain objects', async () => {
    let Build = defineModel({
      name: 'Build',
      table: 'build',
      row: z.object({
        id: z.uuid(),
        user_id: z.uuid(),
        name: z.string(),
        public: z.boolean().default(false)
      }),
      create: z.object({
        name: z.string().min(1)
      }),
      update: z.object({
        name: z.string().min(1).optional()
      })
    });
    let serializeBuild = composeSerializers(
      pickFields(['id', 'name', 'public']),
      renameFields({ user_id: 'userId' })
    );

    let isAuthenticated = defineRule('isAuthenticated', ({ user }) =>
      user ? undefined : forbidden('Sign in first')
    );

    let endpoint = defineEndpoint({
      method: 'post',
      path: '/builds',
      body: Build.create,
      rules: [isAuthenticated],
      async handler({ input, user }) {
        let row = Build.parseRow({
          id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
          user_id: user.id,
          name: input.body.name,
          public: false
        });

        return created({
          success: true,
          build: serializeBuild(row)
        });
      }
    });

    let response = await endpoint.handle({
      body: {
        name: 'The Whip'
      }
    }, {
      user: {
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1'
      }
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      success: true,
      build: {
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
        userId: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
        name: 'The Whip',
        public: false
      }
    });
  });

  it('generates OpenAPI docs from endpoint and model contracts', () => {
    let Build = defineModel({
      name: 'Build',
      table: 'build',
      row: z.object({
        id: z.uuid(),
        user_id: z.uuid(),
        name: z.string(),
        public: z.boolean()
      }),
      create: z.object({
        name: z.string().min(1)
      }),
      update: z.object({
        name: z.string().min(1).optional()
      })
    });
    let BuildPublic = z.object({
      id: z.uuid(),
      userId: z.uuid(),
      name: z.string(),
      public: z.boolean()
    });

    let endpoint = defineEndpoint({
      method: 'get',
      path: '/builds/:buildId',
      auth: true,
      summary: 'Fetch a build',
      tags: ['Builds'],
      params: z.object({
        buildId: z.uuid()
      }),
      query: z.object({
        includeStories: z.boolean().optional()
      }),
      responses: {
        200: {
          description: 'Build found',
          schema: z.object({
            success: z.literal(true),
            build: BuildPublic
          })
        }
      },
      async handler() {
        return {};
      }
    });

    let docs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      endpoints: [endpoint],
      models: [Build]
    });

    let operation = docs.paths['/builds/{buildId}'].get;
    let buildIdParameter = operation.parameters.find(parameter => parameter.name === 'buildId');
    let includeStoriesParameter = operation.parameters.find(parameter => parameter.name === 'includeStories');

    assert.equal(docs.openapi, '3.1.0');
    assert.equal(docs.info.title, 'Example API');
    assert.equal(operation.summary, 'Fetch a build');
    assert.deepEqual(operation.tags, ['Builds']);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.ok(buildIdParameter);
    assert.ok(includeStoriesParameter);
    assert.equal(buildIdParameter.in, 'path');
    assert.equal(buildIdParameter.required, true);
    assert.equal(buildIdParameter.schema.format, 'uuid');
    assert.equal(includeStoriesParameter.in, 'query');
    assert.equal(includeStoriesParameter.required, false);
    assert.equal(operation.responses[200].description, 'Build found');
    assert.equal(operation.responses[200].content['application/json'].schema.properties.build.properties.userId.format, 'uuid');
    assert.equal(docs.components.schemas.BuildCreate.properties.name.minLength, 1);
    assert.equal(docs.components.schemas.BuildRow.properties.public.type, 'boolean');
    assert.equal(docs.components.securitySchemes.bearerAuth.scheme, 'bearer');

    let prefixedDocs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      pathPrefix: '/api',
      endpoints: [endpoint]
    });

    assert.ok(prefixedDocs.paths['/api/builds/{buildId}'].get);
  });

  it('serves OpenAPI docs through the Koa app helper', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      async handler() {
        return {
          ok: true
        };
      }
    });

    let app = createKoaApp({
      bodyParser: false,
      prefix: '/api',
      endpoints: [endpoint],
      openApi: {
        title: 'Health API',
        version: '1.0.0'
      }
    });

    let response = await request(app.callback())
      .get('/openapi.json');

    assert.equal(response.status, 200);
    assert.equal(response.body.info.title, 'Health API');
    assert.ok(response.body.paths['/api/health'].get);
  });

  it('normalizes event-first and metadata-first logger calls', () => {
    let events = [];
    let logger = normalizeLogger((event, metadata) => {
      events.push({
        event,
        metadata
      });
    }).child({
      component: 'api'
    });

    logger.info('server.started', {
      port: 4017
    });
    logger.error({
      error: new Error('Nope')
    }, 'server.failed');

    assert.equal(events[0].event, 'server.started');
    assert.equal(events[0].metadata.component, 'api');
    assert.equal(events[0].metadata.port, 4017);
    assert.equal(events[1].event, 'server.failed');
    assert.equal(events[1].metadata.component, 'api');
    assert.equal(events[1].metadata.error.message, 'Nope');
  });

  it('collects plain domain modules into app wiring inputs', () => {
    let Project = defineModel({
      name: 'Project',
      table: 'project',
      row: z.object({
        id: z.uuid()
      })
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/projects',
      async handler() {
        return ok({
          success: true
        });
      }
    });
    let domains = [
      {
        model: Project,
        endpoint,
        service: ({ db }) => ({
          db
        }),
        name: 'project'
      }
    ];
    let db = {};

    assert.deepEqual(collectModels(domains), [Project]);
    assert.deepEqual(collectEndpoints(domains), [endpoint]);
    assert.deepEqual(createServices(domains, { db }), {
      project: {
        db
      }
    });
  });

  it('creates services with domain-specific dependencies', () => {
    let projectDomain = {
      name: 'project',
      service: dependencies => dependencies
    };
    let discussionDomain = {
      name: 'discussion',
      service: dependencies => dependencies
    };
    let services = createServices([projectDomain, discussionDomain], domain => ({
      logger: `${domain.name}-logger`
    }));

    assert.deepEqual(services, {
      project: {
        logger: 'project-logger'
      },
      discussion: {
        logger: 'discussion-logger'
      }
    });
  });

  it('loads domains that only need boundary schemas in model files', async () => {
    let root = await tempRoot();
    let domainRoot = path.join(root, 'admin-social');

    await fs.mkdir(domainRoot);
    await fs.writeFile(path.join(domainRoot, 'admin-social.model.js'), `
      export let postParams = {
        kind: 'schema-only-boundary-contract'
      };
    `);
    await fs.writeFile(path.join(domainRoot, 'admin-social.serializers.js'), 'export {};\n');
    await fs.writeFile(path.join(domainRoot, 'admin-social.rules.js'), 'export {};\n');
    await fs.writeFile(path.join(domainRoot, 'admin-social.routes.js'), `
      export let listPosts = {
        method: 'GET',
        path: '/admin/social-posts',
        async handle() {
          return {
            status: 200,
            body: {
              posts: []
            }
          };
        }
      };
    `);
    await fs.writeFile(path.join(domainRoot, 'admin-social.service.js'), `
      export function createAdminSocialService() {
        return {
          async listPosts() {
            return [];
          }
        };
      }
    `);

    let domains = await loadDomains(root);

    assert.equal(domains.length, 1);
    assert.equal(domains[0].name, 'adminSocial');
    assert.deepEqual(collectModels(domains), []);
    assert.equal(collectEndpoints(domains).length, 1);
    let services = createServices(domains);

    assert.deepEqual(Object.keys(services), ['adminSocial']);
    assert.deepEqual(await services.adminSocial.listPosts(), []);
  });

  it('loads sparse domain folders and optional normalizers', async () => {
    let root = await tempRoot();
    let domainRoot = path.join(root, 'storm-events');

    await fs.mkdir(domainRoot);
    await fs.writeFile(path.join(domainRoot, 'storm-events.normalizers.js'), `
      export function normalizeStormEventRow(row) {
        return {
          event_id: row.EVENT_ID,
          raw_data: row
        };
      }
    `);
    await fs.writeFile(path.join(domainRoot, 'storm-events.routes.js'), `
      export let health = {
        method: 'GET',
        path: '/storm-events/health',
        async handle() {
          return {
            status: 200,
            body: {
              ok: true
            }
          };
        }
      };
    `);

    let domains = await loadDomains(root);
    let [domain] = domains;

    assert.equal(domains.length, 1);
    assert.equal(domain.name, 'stormEvents');
    assert.deepEqual(collectModels(domains), []);
    assert.equal(collectEndpoints(domains).length, 1);
    assert.deepEqual(createServices(domains), {});
    assert.deepEqual(domain.normalizers.normalizeStormEventRow({
      EVENT_ID: '123'
    }), {
      event_id: '123',
      raw_data: {
        EVENT_ID: '123'
      }
    });
  });

  it('shares request state from rules to handlers through Koa', async () => {
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .get('/projects/unknown');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: 'Project not found.'
    });
  });

  it('runs endpoint middleware before Cricket handles the request through Koa', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      middleware: [
        async (ctx, next) => {
          ctx.state.upload = {
            filename: ctx.get('x-file-name')
          };

          await next();
        }
      ],
      response: z.object({
        success: z.literal(true),
        filename: z.string()
      }),
      async handler({ ctx }) {
        return ok({
          success: true,
          filename: ctx.state.upload.filename
        });
      }
    });

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/uploads')
      .set('x-file-name', 'profile.png');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      success: true,
      filename: 'profile.png'
    });
  });

  it('falls through to afterRoutes when no endpoint matches', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/api/health',
      handler: () => ok({ ok: true })
    });
    let app = createKoaApp({
      endpoints: [endpoint],
      afterRoutes: [
        async (ctx, next) => {
          await next();

          if (ctx.body !== undefined)
            return;

          ctx.status = 200;
          ctx.body = {
            fallback: ctx.path
          };
        }
      ]
    });

    let health = await request(app.callback())
      .get('/api/health');
    let fallback = await request(app.callback())
      .get('/dashboard');

    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, { fallback: '/dashboard' });
  });

  it('exposes adapter file uploads and request origin as plain request data', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      middleware: [
        async (ctx, next) => {
          ctx.file = {
            originalname: 'profile.png',
            size: 123
          };
          ctx.files = [
            ctx.file,
            {
              originalname: 'gallery.png',
              size: 456
            }
          ];

          await next();
        }
      ],
      response: z.object({
        fileName: z.string(),
        fileCount: z.number(),
        origin: z.string(),
        protocol: z.string(),
        host: z.string()
      }),
      async handler({ request }) {
        return ok({
          fileName: request.file.originalname,
          fileCount: request.files.length,
          origin: request.origin,
          protocol: request.protocol,
          host: request.host
        });
      }
    });

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/uploads')
      .set('host', 'api.example.test');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      fileName: 'profile.png',
      fileCount: 2,
      origin: 'http://api.example.test',
      protocol: 'http',
      host: 'api.example.test'
    });
  });

  it('normalizes Koa userId state for endpoint handlers', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/session',
      middleware: [
        async (ctx, next) => {
          ctx.state.user = {
            userId: 'user_123',
            role: 'admin'
          };

          await next();
        }
      ],
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .get('/session');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      userId: 'user_123',
      role: 'admin'
    });
  });

  it('applies handler response headers through Koa', async () => {
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .get('/cacheable');

    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=60');
    assert.equal(response.headers.etag, '"cacheable-v1"');
    assert.deepEqual(response.body, {
      success: true
    });
  });

  it('applies handler response cookies through Koa', async () => {
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/sessions');

    assert.equal(response.status, 201);
    assert.match(response.headers['set-cookie'][0], /accessToken=signed-token/);
    assert.match(response.headers['set-cookie'][0], /httponly/i);
    assert.match(response.headers['set-cookie'][0], /samesite=lax/i);
    assert.deepEqual(response.body, {
      success: true
    });
  });

  it('exposes request cookies to endpoint handlers through Koa', async () => {
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/sessions/refresh')
      .set('Cookie', ['refreshToken=refresh-token-123']);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      refreshToken: 'refresh-token-123'
    });
  });

  it('applies handler redirects through Koa', async () => {
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .get('/verify-email');

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login?verified=true');
  });

  it('adapts existing Koa-shaped services into Cricket handlers', async () => {
    async function createLegacyThing(ctx) {
      ctx.status = 201;
      ctx.body = {
        success: true,
        name: ctx.request.body.name
      };
    }

    let endpoint = defineEndpoint({
      method: 'post',
      path: '/legacy-things',
      body: z.object({
        name: z.string()
      }),
      response: z.object({
        success: z.literal(true),
        name: z.string()
      }),
      handler: fromKoaService(createLegacyThing)
    });

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/legacy-things')
      .send({ name: 'radar note' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      success: true,
      name: 'radar note'
    });
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{"event":"invoice.created"}');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      rawBody: '{"event":"invoice.created"}',
      parsedBodyType: 'undefined'
    });
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

    let app = createKoaApp({
      endpoints: [endpoint]
    });

    let response = await request(app.callback())
      .get('/events')
      .expect(200);

    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.equal(response.text, 'event: snapshot\ndata: {"ok":true}\n\n');
    assert.equal(cleanedUp, true);
  });

  it('combines domain, setup, and app-composed services in the Koa runtime', async () => {
    let messages = [];
    let auditEvents = [];
    let projectDomain = {
      name: 'project',
      endpoints: [
        defineEndpoint({
          method: 'post',
          path: '/projects',
          body: z.object({
            name: z.string()
          }),
          async handler({ input, services }) {
            let project = await services.project.create(input.body);
            await services.mailer.sendProjectCreated(project);
            await services.audit.recordProjectCreated(project);

            return created({
              project
            });
          }
        })
      ],
      services: {
        project() {
          return {
            async create(input) {
              return {
                id: 'project-1',
                name: input.name
              };
            }
          };
        }
      }
    };
    let cricketApp = defineCricketApp({
      domains: [projectDomain],
      async setup() {
        return {
          services: {
            mailer: {
              async sendProjectCreated(project) {
                messages.push(project.name);
              }
            }
          }
        };
      },
      services({ services }) {
        return {
          ...services,
          audit: {
            async recordProjectCreated(project) {
              auditEvents.push({
                projectId: project.id,
                name: project.name
              });
            }
          }
        };
      }
    });
    let runtime = await createCricketKoaRuntime(cricketApp);

    let response = await request(runtime.app.callback())
      .post('/projects')
      .send({ name: 'Launch plan' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      project: {
        id: 'project-1',
        name: 'Launch plan'
      }
    });
    assert.deepEqual(messages, ['Launch plan']);
    assert.deepEqual(auditEvents, [
      {
        projectId: 'project-1',
        name: 'Launch plan'
      }
    ]);
  });

  it('runs shutdown hooks before cleanup in started Koa runtimes', async () => {
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
      onShutdown({ app, signal }) {
        app.context.isShuttingDown = true;
        events.push(`shutdown:${signal}:${app.context.isShuttingDown}`);
      }
    });
    let runtime = await startCricketApp(cricketApp, {
      port: 0,
      logger: {}
    });

    await runtime.stop('SIGTERM');

    assert.deepEqual(events, [
      'shutdown:SIGTERM:true',
      'cleanup'
    ]);
  });

  it('serves folder-loaded domains through Koa with real Knex services', async () => {
    let appModuleUrl = new URL('../fixtures/folder-app/src/app.js', import.meta.url);
    let { app: cricketApp } = await import(appModuleUrl.href);
    let loggerEvents = [];
    let runtime = await createCricketKoaRuntime(cricketApp, {
      baseUrl: appModuleUrl.href,
      logger: {
        info(event, metadata) {
          loggerEvents.push({ event, metadata });
        },
        error(event, metadata) {
          loggerEvents.push({ event, metadata });
        }
      }
    });

    try {
      let docs = await request(runtime.app.callback())
        .get('/openapi.json');

      assert.equal(docs.status, 200);
      assert.equal(docs.body.info.title, 'Folder Build API');
      assert.ok(docs.body.paths['/api/builds'].post);

      let unauthenticated = await request(runtime.app.callback())
        .post('/api/builds')
        .send({ name: 'The Whip' });

      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(unauthenticated.body, {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated'
        }
      });

      let invalid = await request(runtime.app.callback())
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: '' });

      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');

      let blocked = await request(runtime.app.callback())
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: 'forbidden' });

      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.message, 'Choose a better build name');

      let createdBuild = await request(runtime.app.callback())
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: 'The Whip' });

      assert.equal(createdBuild.status, 201);
      assert.deepEqual(createdBuild.body, {
        success: true,
        build: {
          id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
          userId: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
          name: 'The Whip',
          public: false
        }
      });

      let fetchedBuild = await request(runtime.app.callback())
        .get(`/api/builds/${createdBuild.body.build.id}`)
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1');

      assert.equal(fetchedBuild.status, 200);
      assert.deepEqual(fetchedBuild.body, createdBuild.body);

      let missingBuild = await request(runtime.app.callback())
        .get('/api/builds/018f5f7e-9b5f-7d9a-8f69-3f6c3df71af2')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1');

      assert.equal(missingBuild.status, 404);
      assert.equal(missingBuild.body.error.message, 'Build not found');
      assert.ok(loggerEvents.some(event =>
        event.event === 'build.created' &&
        event.metadata.buildId === createdBuild.body.build.id
      ));
    } finally {
      await runtime.cleanup();
    }
  });

  it('composes plain object serializers', () => {
    let serializeProject = composeSerializers(
      pickFields(['id', 'slug']),
      renameFields({
        owner_id: 'ownerId'
      }),
      (row, { user }) => ({
        canEdit: user.id === row.owner_id
      })
    );

    let result = serializeProject({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      slug: 'signal-notes',
      internal_note: 'not included'
    }, {
      user: {
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1'
      }
    });

    assert.deepEqual(result, {
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      slug: 'signal-notes',
      ownerId: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      canEdit: true
    });
  });

  it('maps serializer keys without exposing unselected fields', () => {
    let serializeProject = camelCaseKeys(pickFields([
      'id',
      'owner_id',
      'created_at'
    ]));

    let result = serializeProject({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      created_at: '2026-06-11T19:00:00.000Z',
      internal_note: 'not included'
    });

    assert.deepEqual(result, {
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      ownerId: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      createdAt: '2026-06-11T19:00:00.000Z'
    });

    assert.deepEqual(camelCaseKeys()({
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      'build-name': 'The Whip'
    }), {
      ownerId: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      buildName: 'The Whip'
    });
  });

  it('supports custom serializer key mapping', () => {
    let serializeProject = mapKeys(
      key => `api_${key}`,
      pickFields(['id', 'slug'])
    );

    assert.deepEqual(serializeProject({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      slug: 'signal-notes'
    }), {
      api_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      api_slug: 'signal-notes'
    });
  });

  it('can re-read rows after writes when Knex returning is disabled', async () => {
    let db = knex({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      useNullAsDefault: true
    });

    try {
      await db.schema.createTable('build', table => {
        table.string('id').primary();
        table.string('name').notNullable();
      });

      let Build = defineModel({
        name: 'Build',
        table: 'build',
        row: z.object({
          id: z.uuid(),
          name: z.string()
        })
      });

      let repository = createKnexRepository({
        db,
        model: Build,
        returning: false,
        insert: z.object({
          id: z.uuid(),
          name: z.string()
        }),
        update: z.object({
          name: z.string()
        })
      });

      let inserted = await repository.insert({
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
        name: 'The Whip'
      });
      let updated = await repository.updateById(inserted.id, {
        name: 'The Whip II'
      });

      assert.deepEqual(inserted, {
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
        name: 'The Whip'
      });
      assert.deepEqual(updated, {
        id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
        name: 'The Whip II'
      });
    } finally {
      await db.destroy();
    }
  });
});
