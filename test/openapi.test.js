import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deprecateEndpoint,
  defineEndpoint,
  defineModel,
  field,
  generateOpenApi,
  respond,
  z
} from '../src/index.js';

describe('Cricket OpenAPI', () => {
  it('documents the runtime default status when no response schema is declared', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/events',
      handler() {
        return { accepted: true };
      }
    });
    let response = await endpoint.handle({});
    let docs = generateOpenApi({ endpoints: [endpoint] });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(docs.paths['/events'].post.responses), ['201']);
  });

  it('keeps explicit response status aligned with declared OpenAPI responses', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/imports',
      responses: {
        202: z.object({
          queued: z.literal(true)
        })
      },
      handler() {
        return respond(202, {
          queued: true
        });
      }
    });
    let response = await endpoint.handle({});
    let docs = generateOpenApi({ endpoints: [endpoint] });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { queued: true });
    assert.deepEqual(Object.keys(docs.paths['/imports'].post.responses), ['202']);
  });

  it('generates OpenAPI docs from endpoint and model contracts', () => {
    let Build = defineModel({
      name: 'Build',
      table: 'build',
      row: {
        id: field.public(z.uuid()),
        user_id: field.private(z.uuid(), { sensitive: true }),
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
    assert.equal(operation.operationId, 'getBuildsBuildId');
    assert.deepEqual(operation.tags, ['Builds']);
    assert.equal(operation.rules, undefined);
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
    assert.equal(docs.components.schemas.BuildPublic.properties.id.cricket, undefined);
    assert.equal(docs.components.schemas.BuildPublic.properties.id.sensitive, undefined);

    let prefixedDocs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      pathPrefix: '/api',
      endpoints: [endpoint]
    });

    assert.ok(prefixedDocs.paths['/api/builds/{buildId}'].get);
  });

  it('represents date fields as date-time strings in generated docs', () => {
    let Event = defineModel({
      name: 'Event',
      table: 'event',
      row: {
        id: field.public(z.uuid()),
        happened_at: field.public(z.date())
      }
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events/:eventId',
      params: z.object({
        eventId: z.uuid()
      }),
      responses: {
        200: {
          schema: z.object({
            event: z.object({
              happenedAt: z.date()
            })
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
      models: [Event]
    });

    let responseSchema = docs.paths['/events/{eventId}'].get
      .responses[200].content['application/json'].schema;

    assert.deepEqual(responseSchema.properties.event.properties.happenedAt, {
      type: 'string',
      format: 'date-time'
    });
    assert.deepEqual(docs.components.schemas.EventPublic.properties.happened_at, {
      type: 'string',
      format: 'date-time'
    });
  });

  it('allows free-form query schemas without named OpenAPI parameters', () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/events',
      query: z.record(z.string(), z.unknown()).optional(),
      responses: {
        200: z.object({
          events: z.array(z.object({ id: z.uuid() }))
        })
      },
      async handler() {
        return {};
      }
    });

    let docs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      endpoints: [endpoint]
    });

    assert.equal(docs.paths['/events'].get.parameters, undefined);
  });

  it('marks deprecated endpoints in generated OpenAPI', () => {
    let endpoint = deprecateEndpoint(defineEndpoint({
      method: 'post',
      path: '/sdk/check-shas',
      responses: {
        200: z.object({
          success: z.literal(true)
        })
      },
      async handler() {
        return {};
      }
    }), {
      since: '2026-06-17',
      sunset: '2026-09-01',
      replacement: {
        method: 'post',
        path: '/sdk/screenshots/batch'
      },
      reason: 'Use the batch screenshot upload flow instead.'
    });

    let docs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      endpoints: [endpoint]
    });
    let operation = docs.paths['/sdk/check-shas'].post;

    assert.equal(operation.deprecated, true);
    assert.deepEqual(operation['x-cricket-deprecation'], {
      since: '2026-06-17',
      sunset: '2026-09-01',
      replacement: {
        method: 'POST',
        path: '/sdk/screenshots/batch'
      },
      reason: 'Use the batch screenshot upload flow instead.'
    });
    assert.equal(operation.responses[200].description, 'Success');
  });

});
