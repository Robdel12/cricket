import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defineEndpoint,
  defineModel,
  field,
  generateOpenApi,
  z
} from '../src/index.js';

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

    let prefixedDocs = generateOpenApi({
      title: 'Example API',
      version: '1.0.0',
      pathPrefix: '/api',
      endpoints: [endpoint]
    });

    assert.ok(prefixedDocs.paths['/api/builds/{buildId}'].get);
  });

});
