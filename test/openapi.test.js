import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deprecateEndpoint,
  defineApiVersions,
  defineEndpoint,
  defineModel,
  defineNormalizer,
  defineSerializer,
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

  it('projects endpoint-owned API versions into exact OpenAPI contracts', () => {
    let CurrentInput = z.object({
      durationMinutes: z.number()
    });
    let LegacyInput = z.object({
      duration_seconds: z.number()
    });
    let CurrentResponse = z.object({
      id: z.string(),
      durationMinutes: z.number()
    });
    let LegacyResponse = z.object({
      session_id: z.string(),
      duration_seconds: z.number()
    });
    let normalizeLegacy = defineNormalizer({
      name: 'session.input.legacy',
      source: LegacyInput,
      output: CurrentInput,
      normalize(value) {
        return {
          durationMinutes: value.duration_seconds / 60
        };
      }
    });
    let serializeLegacy = defineSerializer({
      name: 'session.output.legacy',
      output: LegacyResponse,
      serialize(value) {
        return {
          session_id: value.id,
          duration_seconds: value.durationMinutes * 60
        };
      }
    });
    let versions = defineApiVersions({
      name: 'tornadic.ios',
      header: 'Tornadic-Version',
      current: '2026-09-01',
      default: '2025-11-15',
      versions: {
        '2025-11-15': {},
        '2026-09-01': {}
      }
    });
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/sessions',
      apiVersions: versions({
        '2025-11-15': {
          body: normalizeLegacy,
          responses: {
            201: serializeLegacy
          }
        }
      }),
      body: CurrentInput,
      responses: {
        201: {
          description: 'Session created',
          schema: CurrentResponse
        }
      },
      handler() {
        return {};
      }
    });
    let defaultDocs = generateOpenApi({ endpoints: [endpoint] });
    let currentDocs = generateOpenApi({
      endpoints: [endpoint],
      apiVersions: {
        'tornadic.ios': '2026-09-01'
      }
    });
    let defaultOperation = defaultDocs.paths['/sessions'].post;
    let currentOperation = currentDocs.paths['/sessions'].post;
    let defaultHeader = defaultOperation.parameters.find(parameter =>
      parameter.name === 'Tornadic-Version'
    );
    let currentHeader = currentOperation.parameters.find(parameter =>
      parameter.name === 'Tornadic-Version'
    );

    assert.ok(defaultOperation.requestBody.content['application/json'].schema.properties.duration_seconds);
    assert.ok(defaultOperation.responses[201].content['application/json'].schema.properties.session_id);
    assert.equal(defaultOperation.responses[201].description, 'Session created');
    assert.deepEqual(defaultHeader.schema, {
      type: 'string',
      enum: ['2025-11-15'],
      default: '2025-11-15'
    });
    assert.equal(defaultHeader.required, false);
    assert.ok(currentOperation.requestBody.content['application/json'].schema.properties.durationMinutes);
    assert.ok(currentOperation.responses[201].content['application/json'].schema.properties.id);
    assert.equal(currentHeader.required, true);
    assert.deepEqual(currentHeader.schema.enum, ['2026-09-01']);

    assert.throws(() => generateOpenApi({
      endpoints: [endpoint],
      apiVersions: {
        'tornadic.ios': 'unknown'
      }
    }), /Unknown tornadic\.ios API version/);
    assert.throws(() => generateOpenApi({
      endpoints: [endpoint],
      apiVersions: {
        typo: '2026-09-01'
      }
    }), /Unknown API version family typo/);
  });

});
