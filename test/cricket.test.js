import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import knex from 'knex';
import request from 'supertest';

import {
  camelCaseKeys,
  collectEndpoints,
  collectModels,
  composeSerializers,
  created,
  createCricketRuntime,
  createKnexRepository,
  createCricketLogger,
  createServices,
  defineCricketApp,
  defineEndpoint,
  defineModel,
  defineNormalizer,
  defineRule,
  defineSerializer,
  field,
  fieldSensitive,
  forbidden,
  generateOpenApi,
  loadDomains,
  mapKeys,
  normalizeLogger,
  ok,
  pickFields,
  renameFields,
  resolveLogger,
  z
} from '../src/index.js';
import {
  createHttpApp
} from './fixtures/http.js';

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-'));
}

describe('Cricket core', () => {
  it('derives public and named model views from field visibility', () => {
    let Account = defineModel({
      name: 'Account',
      table: 'account',
      row: {
        id: field.public(z.uuid()),
        owner_id: field.private(z.uuid(), { sensitive: true }),
        email: field.public(z.email(), { sensitive: true })
      },
      views: {
        owner: ['id', 'owner_id', 'email']
      }
    });

    assert.deepEqual(Account.parsePublic({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      email: 'driver@example.com'
    }), {
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      email: 'driver@example.com'
    });

    assert.throws(() => Account.parsePublic({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      email: 'driver@example.com'
    }), error => error.code === 'VALIDATION_FAILED');

    assert.deepEqual(Account.parseOwner({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      email: 'driver@example.com'
    }), {
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      email: 'driver@example.com'
    });

    let docs = generateOpenApi({
      title: 'Accounts API',
      version: '1.0.0',
      models: [Account]
    });

    assert.equal(docs.components.schemas.AccountPublic.properties.owner_id, undefined);
    assert.equal(docs.components.schemas.AccountOwner.properties.owner_id.format, 'uuid');
    assert.deepEqual(Account.fieldMetadata, {
      id: {
        visibility: 'public',
        sensitive: false
      },
      owner_id: {
        visibility: 'private',
        sensitive: true
      },
      email: {
        visibility: 'public',
        sensitive: true
      }
    });
    assert.equal(Object.isFrozen(Account.fieldMetadata), true);
    assert.equal(Object.isFrozen(Account.fieldMetadata.email), true);
    assert.equal(fieldSensitive(Account.fields.email), true);

    assert.throws(() => defineModel({
      name: 'Profile',
      table: 'profile',
      row: {
        id: field.public(z.uuid())
      },
      views: {
        'owner-view': ['id'],
        owner_view: ['id']
      }
    }), /duplicate helper parseOwnerView/);
  });


  it('defaults model fields to not sensitive unless declared', () => {
    assert.equal(fieldSensitive(field.public(z.string())), false);
    assert.equal(fieldSensitive(field.private(z.string())), false);
    assert.throws(() => field.private(z.string(), { sensitive: 'credential' }), /needs sensitive true or false/);
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


  it('creates structured Cricket log lines with child metadata and redaction', () => {
    let lines = [];
    let logger = createCricketLogger({
      service: 'build-api',
      level: 'debug',
      write(line) {
        lines.push(line);
      }
    }).child({
      requestId: 'req_123',
      route: {
        operationId: 'getBuild'
      }
    });

    logger.info('http.response.finished', {
      status: 200,
      authorization: 'Bearer nope',
      error: new Error('Example')
    });

    let log = JSON.parse(lines[0]);

    assert.equal(log.level, 'info');
    assert.equal(log.event, 'http.response.finished');
    assert.equal(log.service, 'build-api');
    assert.equal(log.requestId, 'req_123');
    assert.deepEqual(log.route, { operationId: 'getBuild' });
    assert.equal(log.metadata.status, 200);
    assert.equal(log.metadata.authorization, '[Redacted]');
    assert.deepEqual(log.metadata.error, {
      name: 'Error',
      message: 'Example'
    });
  });


  it('filters levels and supports pretty Cricket log lines', () => {
    let lines = [];
    let logger = createCricketLogger({
      service: 'build-api',
      level: 'warn',
      format: 'pretty',
      write(line) {
        lines.push(line);
      }
    });

    logger.info('ignored');
    logger.error('server.failed', {
      requestId: 'req_456'
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /ERROR build-api req_456 server\.failed/);
  });


  it('resolves omitted and configured loggers into Cricket structured loggers', () => {
    let lines = [];
    let defaultLogger = resolveLogger(undefined, {
      service: 'default-api',
      write(line) {
        lines.push(JSON.parse(line));
      }
    });
    let configuredLogger = resolveLogger({
      level: 'error',
      service: 'configured-api',
      write(line) {
        lines.push(JSON.parse(line));
      }
    });

    defaultLogger.info('server.started');
    configuredLogger.info('ignored');
    configuredLogger.error('server.failed');

    assert.deepEqual(lines.map(log => log.event), [
      'server.started',
      'server.failed'
    ]);
    assert.equal(lines[0].service, 'default-api');
    assert.equal(lines[1].service, 'configured-api');
    assert.throws(() => resolveLogger({
      leveL: 'debug'
    }), /Logger config needs at least one known logger option/);
    assert.throws(() => resolveLogger({
      level: 'debug',
      transport: 'file'
    }), /Unknown logger option transport/);
  });


  it('rejects private field leaks at the serializer boundary through HTTP', async () => {
    let User = defineModel({
      name: 'User',
      table: 'user',
      row: {
        id: field.public(z.uuid()),
        email: field.private(z.email(), { sensitive: true }),
        name: field.public(z.string())
      }
    });
    let serializeUser = defineSerializer({
      name: 'user.public',
      output: User.public,
      serialize(row) {
        return {
          id: row.id,
          email: row.email,
          name: row.name
        };
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
          user: serializeUser({
            id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
            email: 'driver@example.com',
            name: 'Driver'
          })
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
      .get('/users/me');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'SERIALIZER_CONTRACT_FAILED');
  });


  it('rejects missing required serializer output through HTTP', async () => {
    let User = defineModel({
      name: 'User',
      table: 'user',
      row: {
        id: field.public(z.uuid()),
        name: field.public(z.string())
      }
    });
    let serializeUser = defineSerializer({
      name: 'user.public',
      output: User.public,
      serialize(row) {
        return {
          id: row.id
        };
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
          user: serializeUser({
            id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
            name: 'Driver'
          })
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
      .get('/users/me');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'SERIALIZER_CONTRACT_FAILED');
  });


  it('normalizes source payloads into validated app input', () => {
    let CreateUserInput = z.object({
      email: z.email(),
      name: z.string().min(1)
    });
    let normalizeUser = defineNormalizer({
      name: 'user.import',
      source: z.object({
        EMAIL: z.string(),
        NAME: z.string()
      }).passthrough(),
      output: CreateUserInput,
      normalize(row) {
        if (row.NAME === 'skip')
          return null;

        return {
          email: row.EMAIL,
          name: row.NAME
        };
      }
    });

    assert.deepEqual(normalizeUser({
      EMAIL: 'driver@example.com',
      NAME: 'Driver',
      EXTRA: true
    }), {
      email: 'driver@example.com',
      name: 'Driver'
    });
    assert.equal(normalizeUser({
      EMAIL: 'driver@example.com',
      NAME: 'skip'
    }), null);
    assert.throws(() => normalizeUser({
      EMAIL: 'not-an-email',
      NAME: 'Driver'
    }), {
      code: 'NORMALIZER_CONTRACT_FAILED'
    });
    assert.throws(() => normalizeUser({
      EMAIL: 'driver@example.com'
    }), {
      code: 'VALIDATION_FAILED'
    });
  });


  it('collects plain domain modules into app wiring inputs', () => {
    let Project = defineModel({
      name: 'Project',
      table: 'project',
      row: {
        id: field.public(z.uuid())
      }
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


  it('rejects endpoint paths that do not start with a slash', async () => {
    await assert.rejects(
      createCricketRuntime(defineCricketApp({
        endpoints: [
          {
            method: 'GET',
            path: 'projects',
            async handle() {
              return ok({ success: true });
            }
          }
        ]
      })),
      /GET projects needs a path that starts with \//
    );
  });


  it('combines domain, setup, and app-composed services in the Cricket runtime', async () => {
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
    let runtime = await createCricketRuntime(cricketApp, {
      logger() {}
    });

    let response = await request(runtime.app)
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


  it('serves folder-loaded domains through Cricket HTTP with real Knex services', async () => {
    let appModuleUrl = new URL('../fixtures/folder-app/src/app.js', import.meta.url);
    let { app: cricketApp } = await import(appModuleUrl.href);
    let loggerEvents = [];
    let runtime = await createCricketRuntime(cricketApp, {
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
      let unauthenticated = await request(runtime.app)
        .post('/api/builds')
        .send({ name: 'The Whip' });

      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(unauthenticated.body, {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated'
        }
      });

      let invalid = await request(runtime.app)
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: '' });

      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');

      let blocked = await request(runtime.app)
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: 'forbidden' });

      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.message, 'Choose a better build name');

      let createdBuild = await request(runtime.app)
        .post('/api/builds')
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1')
        .send({ name: 'The Whip' });

      assert.equal(createdBuild.status, 201);
      assert.deepEqual(createdBuild.body, {
        success: true,
        build: {
          id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
          name: 'The Whip',
          public: false
        }
      });

      let fetchedBuild = await request(runtime.app)
        .get(`/api/builds/${createdBuild.body.build.id}`)
        .set('authorization', 'Bearer 018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1');

      assert.equal(fetchedBuild.status, 200);
      assert.deepEqual(fetchedBuild.body, createdBuild.body);

      let missingBuild = await request(runtime.app)
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


  it('preserves explicit empty endpoints and models when resolving loaded domains', async () => {
    let root = await tempRoot();
    let domainRoot = path.join(root, 'projects');

    await fs.mkdir(domainRoot);
    await fs.writeFile(path.join(domainRoot, 'projects.model.js'), `
      export let Project = {
        name: 'Project'
      };
    `);
    await fs.writeFile(path.join(domainRoot, 'projects.routes.js'), `
      export let listProjects = {
        method: 'GET',
        path: '/projects',
        async handle() {
          return {
            status: 200,
            body: {
              projects: []
            }
          };
        }
      };
    `);

    let runtime = await createCricketRuntime(defineCricketApp({
      domains: root,
      endpoints: [],
      models: []
    }));

    assert.deepEqual(runtime.contract.endpoints, []);
    assert.deepEqual(runtime.contract.models, []);
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
        row: {
          id: field.public(z.uuid()),
          name: field.public(z.string())
        }
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


  it('validates input, applies rules, and serializes plain objects', async () => {
    let Build = defineModel({
      name: 'Build',
      table: 'build',
      row: {
        id: field.public(z.uuid()),
        user_id: field.private(z.uuid(), { sensitive: true }),
        name: field.public(z.string()),
        public: field.public(z.boolean().default(false))
      }
    });
    let BuildCreateInput = z.object({
      name: z.string().min(1)
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
      body: BuildCreateInput,
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


});
