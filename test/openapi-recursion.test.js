import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defineApiVersions, defineEndpoint, defineSerializer, generateOpenApi, z
} from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';
import { defineManualTestApp } from '../test-support/app.js';

// Follow the document pointers a schema consumer receives, without depending on
// generated component names or flattening recursive schemas.
function resolve(document, schema) {
  if (!schema.$ref) return schema;
  assert.ok(schema.$ref.startsWith('#/'));
  let target = decodeURIComponent(schema.$ref.slice(2)).split('/').reduce(
    (value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document
  );
  assert.ok(target, `Missing schema: ${schema.$ref}`);
  return resolve(document, target);
}

function responseSchema(document, path, method = 'get', status = 200) {
  return resolve(document, document.paths[path][method].responses[status].content['application/json'].schema);
}

let Reply = z.object({
  text: z.string(),
  get replies() { return z.array(Reply); }
});
let thread = { text: 'First', replies: [{ text: 'Second', replies: [] }] };

describe('Recursive OpenAPI schemas', () => {
  it('preserves recursive request and response contracts through HTTP', async t => {
    let endpoint = defineEndpoint({
      method: 'post', path: '/replies', body: Reply, response: Reply,
      handler: ({ input }) => input.body
    });
    let invalid = defineEndpoint({
      method: 'get', path: '/invalid', response: Reply,
      handler: () => ({ text: 'First', replies: [{}] })
    });
    let runtime = await createTestRuntime(defineManualTestApp({ endpoints: [endpoint, invalid] }));
    t.after(() => runtime.cleanup());
    let accepted = await runtime.api.post('/replies', { body: thread });
    assert.equal(accepted.status, 201);
    assert.deepEqual(accepted.body, thread);
    assert.equal((await runtime.api.post('/replies', { body: { text: 'First', replies: [{}] } })).status, 422);
    let rejected = await runtime.api.get('/invalid');
    assert.equal(rejected.status, 500);
    assert.equal(rejected.body.error.code, 'RESPONSE_CONTRACT_FAILED');

    let document = generateOpenApi({ endpoints: [endpoint] });
    let input = resolve(document, document.paths['/replies'].post.requestBody.content['application/json'].schema);
    let output = responseSchema(document, '/replies', 'post', 201);
    for (let schema of [input, output]) {
      assert.deepEqual(schema.required, ['text', 'replies']);
      assert.equal(resolve(document, schema.properties.replies.items), schema);
    }
    assert.equal(output.additionalProperties, false);
    assert.notEqual(input, output);
  });

  it('keeps nested JSON definitions separate across current and historical projections', async t => {
    let versions = defineApiVersions({
      name: 'reports', header: 'Report-Version', current: 'current', default: 'legacy',
      versions: { legacy: {}, current: {} }
    });
    let canonical = z.object({ id: z.string(), payload: z.json(), internalSecret: z.string() });
    let current = defineSerializer({
      name: 'report.current', output: z.object({ id: z.string() }), serialize: value => value
    });
    let legacy = defineSerializer({
      name: 'report.legacy', output: z.object({ id: z.string(), payload: z.json() }), serialize: value => value
    });
    let payload = { nested: [1, null, { enabled: true }] };
    let endpoint = defineEndpoint({
      method: 'get', path: '/report', response: { schema: canonical, serializer: current },
      apiVersions: versions({ legacy: { response: legacy } }),
      handler: () => ({ id: 'report-1', payload, internalSecret: 'private' })
    });
    let other = defineEndpoint({ method: 'get', path: '/replies', response: z.object({ thread: Reply }), handler: () => ({ thread }) });
    let runtime = await createTestRuntime(defineManualTestApp({ endpoints: [endpoint, other] }));
    t.after(() => runtime.cleanup());
    assert.deepEqual((await runtime.api.get('/report')).body, { id: 'report-1', payload });
    assert.deepEqual((await runtime.api.get('/report', { headers: { 'Report-Version': 'current' } })).body, { id: 'report-1' });
    assert.deepEqual((await runtime.api.get('/replies')).body, { thread });

    let document = generateOpenApi({ endpoints: [endpoint, other] });
    let json = resolve(document, responseSchema(document, '/report').properties.payload);
    let array = json.anyOf.find(schema => schema.type === 'array');
    let object = json.anyOf.find(schema => schema.type === 'object');
    assert.equal(resolve(document, array.items), json);
    assert.equal(resolve(document, object.additionalProperties), json);
    let reply = resolve(document, responseSchema(document, '/replies').properties.thread);
    assert.equal(resolve(document, reply.properties.replies.items), reply);
    assert.deepEqual(reply.required, ['text', 'replies']);
    assert.notEqual(reply, json);
    assert.equal(JSON.stringify(document).includes('internalSecret'), false);
    let currentDocs = generateOpenApi({ endpoints: [endpoint], apiVersions: { reports: 'current' } });
    assert.deepEqual(responseSchema(currentDocs, '/report').required, ['id']);
    assert.equal(currentDocs.components, undefined);
    assert.deepEqual(generateOpenApi({ endpoints: [endpoint, other] }), document);
    assert.ok(Object.isFrozen(json.anyOf));
  });

  it('preserves local definitions when extracting parameters and multipart fields', () => {
    let endpoint = defineEndpoint({
      method: 'post', path: '/uploads', multipart: { maxFiles: 1 },
      query: z.object({ filter: z.json().optional() }),
      body: z.object({ metadata: z.json() }),
      requestBody: { files: z.object({ asset: z.string().meta({ format: 'binary' }) }) },
      response: { schema: z.string(), headers: { 'X-Details': { schema: z.json() } } },
      handler: () => 'uploaded'
    });
    let document = generateOpenApi({ endpoints: [endpoint] });
    let operation = document.paths['/uploads'].post;
    for (let schema of [
      operation.parameters[0].schema,
      operation.requestBody.content['multipart/form-data'].schema.properties.metadata,
      operation.responses[201].headers['X-Details'].schema
    ]) {
      let json = resolve(document, schema);
      assert.equal(resolve(document, json.anyOf.find(item => item.type === 'array').items), json);
    }
    assert.equal(operation.requestBody.content['multipart/form-data'].schema.properties.asset.format, 'binary');
  });

  it('preserves caller references and example data without mutating schemas or colliding with model names', () => {
    let example = { $ref: '#/ordinary-example-data' };
    let schema = z.object({ payload: z.json() }).meta({ examples: [example] });
    let before = z.toJSONSchema(schema);
    let model = { name: 'RecursiveSchema', views: { 1: z.object({ label: z.string() }) } };
    let explicit = { $ref: '#/components/schemas/RecursiveSchema1' };
    let endpoints = [
      defineEndpoint({ method: 'get', path: '/data', response: schema, handler: () => ({}) }),
      defineEndpoint({ method: 'get', path: '/named', response: { schema: explicit }, handler: () => ({}) })
    ];
    let document = generateOpenApi({ endpoints, models: [model] });
    assert.equal(responseSchema(document, '/named').properties.label.type, 'string');
    assert.deepEqual(document.paths['/named'].get.responses[200].content['application/json'].schema, explicit);
    assert.deepEqual(responseSchema(document, '/data').examples, [example]);
    assert.deepEqual(z.toJSONSchema(schema), before);
    assert.equal(Object.isFrozen(example), false);
    assert.equal(Object.isFrozen(explicit), false);
    assert.ok(Object.isFrozen(responseSchema(document, '/data')));
  });
});
