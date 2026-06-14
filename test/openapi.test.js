import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import {
  defineEndpoint,
  defineModel,
  field,
  generateOpenApi,
  ok,
  z
} from '../src/index.js';
import {
  createHttpApp
} from './fixtures/http.js';

describe('Cricket OpenAPI', () => {
  it('generates OpenAPI docs from endpoint and model contracts', () => {
    let Build = defineModel({
      name: 'Build',
      table: 'build',
      row: {
        id: field.public(z.uuid()),
        user_id: field.private(z.uuid()),
        name: field.public(z.string()),
        public: field.public(z.boolean())
      }
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
    assert.equal(docs.components.schemas.BuildPublic.properties.public.type, 'boolean');
    assert.equal(docs.components.schemas.BuildPublic.properties.user_id, undefined);
    assert.equal(docs.components.securitySchemes.bearerAuth.scheme, 'bearer');

    let prefixedDocs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      pathPrefix: '/api',
      endpoints: [endpoint]
    });

    assert.ok(prefixedDocs.paths['/api/builds/{buildId}'].get);
  });


  it('omits bearer auth components when no endpoints require auth', () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          success: true
        });
      }
    });

    let docs = generateOpenApi({
      endpoints: [endpoint]
    });

    assert.equal(docs.paths['/health'].get.security, undefined);
    assert.equal(docs.components, undefined);
  });


  it('serves OpenAPI docs through the Cricket runtime', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      async handler() {
        return {
          ok: true
        };
      }
    });

    let app = await createHttpApp({
      prefix: '/api',
      endpoints: [endpoint],
      openApi: {
        title: 'Health API',
        version: '1.0.0'
      }
    });

    let response = await request(app)
      .get('/openapi.json');

    assert.equal(response.status, 200);
    assert.equal(response.body.info.title, 'Health API');
    assert.ok(response.body.paths['/api/health'].get);
  });


  it('only serves OpenAPI docs for GET requests', async () => {
    let app = await createHttpApp({
      openApi: true,
      endpoints: []
    });

    let response = await request(app)
      .post('/openapi.json');

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });


  it('runs app exchange hooks around OpenAPI docs', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler: () => ok({ ok: true })
    });
    let app = await createHttpApp({
      endpoints: [endpoint],
      openApi: true,
      use: [
        async (exchange, next) => {
          let response = await next(exchange);

          return {
            ...response,
            headers: {
              ...response.headers,
              'x-request-id': 'req_openapi'
            }
          };
        }
      ]
    });

    let response = await request(app)
      .get('/openapi.json');

    assert.equal(response.status, 200);
    assert.equal(response.headers['x-request-id'], 'req_openapi');
    assert.equal(response.body.openapi, '3.1.0');
  });


});
