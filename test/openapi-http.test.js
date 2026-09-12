import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import request from 'supertest';

import {
  defineEndpoint, defineModel, defineRule, field, generateOpenApi, ok, respond,
  unauthenticated, withHeaders, z
} from '../src/index.js';
import { createOpenApiFromContract } from '../src/app-contract.js';
import { createTestRuntime } from '../src/test/index.js';
import { defineManualTestApp } from '../test-support/app.js';

let execFileAsync = promisify(execFile);

describe('Public HTTP contracts and generated OpenAPI', () => {
  it('describes credentials and validated headers while rules enforce access to real rows', async () => {
    let schemes = { bearer: { type: 'http', scheme: 'bearer', description: 'Project credential' } };
    let auth = [{ bearer: [] }];
    let requireProject = defineRule('project.access', async ({ request: incoming, db }) => {
      let project = await db('projects').where({ credential: incoming.headers.authorization ?? '' }).first();
      if (!project) throw unauthenticated('Project credential required');
      return { project };
    });
    let endpoint = defineEndpoint({
      method: 'get', path: '/project', auth,
      headers: z.object({ 'x-client-revision': z.string().regex(/^\d+$/).transform(Number).pipe(z.number()) }).strict(),
      rules: [requireProject],
      responses: {
        200: {
          schema: z.object({ name: z.string(), revision: z.number() }),
          headers: { 'X-RateLimit-Remaining': { schema: z.string().regex(/^\d+$/), example: '9' } },
          example: { name: 'Demo', revision: 4 }
        },
        401: { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) }
      },
      handler: ({ project, input }) => withHeaders(ok({ ...project, revision: input.headers['x-client-revision'] }), {
        'X-RateLimit-Remaining': '9'
      })
    });
    let app = defineManualTestApp({
      authMethods: schemes, endpoints: [endpoint],
      database: { client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true },
      async setup({ db }) {
        await db.schema.createTable('projects', table => {
          table.string('name'); table.string('credential');
        });
        await db('projects').insert({ name: 'Demo', credential: 'Bearer test-project' });
      }
    });
    schemes.bearer.description = 'Caller mutation';
    auth[0].bearer.push('unexpected');
    let docs = createOpenApiFromContract(app);
    let operation = docs.paths['/project'].get;
    assert.equal(docs.components.securitySchemes.bearer.description, 'Project credential');
    assert.deepEqual(operation.security, [{ bearer: [] }]);
    assert.equal(operation.auth, undefined);
    assert.equal(docs.components.authMethods, undefined);
    assert.deepEqual(operation.parameters[0].schema.type, 'string');
    assert.ok(Object.isFrozen(docs.components.securitySchemes.bearer));
    assert.equal(Object.isFrozen(schemes), false);
    let runtime = await createTestRuntime(app);
    try {
      let accepted = await runtime.api.get('/project', { headers: { Authorization: 'Bearer test-project', 'X-Client-Revision': '4' } });
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.body, { name: 'Demo', revision: 4 });
      assert.equal(accepted.headers['x-ratelimit-remaining'], operation.responses[200].headers['X-RateLimit-Remaining'].example);
      let denied = await runtime.api.get('/project', { headers: { 'X-Client-Revision': '4' } });
      assert.equal(denied.status, 401);
      let malformed = await runtime.api.get('/project', { headers: { Authorization: 'Bearer test-project', 'X-Client-Revision': 'four' } });
      assert.equal(malformed.status, 422);
    } finally { await runtime.cleanup(); }
  });

  it('uses input schemas for JSON requests and serialized output schemas for responses', async () => {
    let endpoint = defineEndpoint({
      method: 'post', path: '/measurements',
      body: z.object({ value: z.string().regex(/^\d+$/).transform(Number).pipe(z.number()) }),
      response: z.object({ value: z.string().transform(Number).pipe(z.number()), cricket: z.string(), at: z.date() }),
      requestBody: { description: 'A decimal measurement', example: { value: '12' } },
      handler: ({ input }) => ({ value: String(input.body.value), cricket: 'a real field', at: new Date('2026-01-01T00:00:00Z'), private: 'never sent' })
    });
    let docs = generateOpenApi({ endpoints: [endpoint] }).paths['/measurements'].post;
    assert.equal(docs.requestBody.content['application/json'].schema.properties.value.type, 'string');
    let output = docs.responses[201].content['application/json'].schema;
    assert.equal(output.properties.value.type, 'number');
    assert.equal(output.properties.cricket.type, 'string');
    assert.equal(output.properties.at.format, 'date-time');
    assert.equal(output.additionalProperties, false);
    let runtime = await createTestRuntime(defineManualTestApp({ endpoints: [endpoint] }));
    try {
      let result = await runtime.api.post('/measurements', { body: docs.requestBody.content['application/json'].example });
      assert.deepEqual(result.body, { value: 12, cricket: 'a real field', at: '2026-01-01T00:00:00.000Z' });
      assert.equal((await runtime.api.post('/measurements', { body: { value: 'nope' } })).status, 422);
    } finally { await runtime.cleanup(); }
  });

  it('describes multipart file parts, downloads and bodyless responses without claiming JSON', async () => {
    let bytes = Buffer.from('actual file bytes');
    let binary = z.instanceof(Buffer).meta({ jsonSchema: { type: 'string', format: 'binary' } });
    let upload = defineEndpoint({
      method: 'post', path: '/files', multipart: { maxFiles: 1, maxFileBytes: 128 },
      body: z.object({ label: z.string().min(1) }),
      requestBody: { files: { type: 'object', properties: { asset: { type: 'string', format: 'binary' } } } },
      response: z.object({ label: z.string(), content: z.string() }),
      handler: async ({ input, request: incoming }) => ({ label: input.body.label, content: incoming.files.length ? await readFile(incoming.files[0].path, 'utf8') : '' })
    });
    let download = defineEndpoint({
      method: 'get', path: '/files/latest',
      response: { schema: binary, contentType: 'application/octet-stream' },
      handler: () => withHeaders(ok(bytes), { 'Content-Type': 'application/octet-stream' })
    });
    let remove = defineEndpoint({ method: 'delete', path: '/files/latest', responses: { 204: { description: 'Removed' } }, handler: () => respond(204) });
    let endpoints = [upload, download, remove];
    let docs = generateOpenApi({ endpoints });
    let uploadSchema = docs.paths['/files'].post.requestBody.content['multipart/form-data'].schema;
    assert.deepEqual(uploadSchema.required, ['label']);
    assert.equal(uploadSchema.properties.asset.format, 'binary');
    assert.equal(uploadSchema.properties.label.type, 'string');
    assert.equal(docs.paths['/files/latest'].get.responses[200].content['application/octet-stream'].schema.format, 'binary');
    assert.equal(docs.paths['/files/latest'].delete.responses[204].content, undefined);
    let runtime = await createTestRuntime(defineManualTestApp({ endpoints }));
    try {
      let uploaded = await request(runtime.runtime.app).post('/files').field('label', 'Example').attach('asset', bytes, 'sample.bin');
      assert.equal(uploaded.status, 201);
      assert.deepEqual(uploaded.body, { label: 'Example', content: bytes.toString() });
      let downloaded = await request(runtime.runtime.app).get('/files/latest');
      assert.deepEqual(downloaded.body, bytes);
      assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
      assert.equal((await request(runtime.runtime.app).delete('/files/latest')).text, '');
      assert.equal((await request(runtime.runtime.app).post('/files').field('label', 'Example').attach('asset', Buffer.alloc(129), 'large.bin')).status, 413);
    } finally { await runtime.cleanup(); }
  });

  it('fails ambiguous or undescribable contracts rather than silently weakening documentation', () => {
    let endpoint = config => defineEndpoint({ method: 'get', path: '/items/:id', handler: () => ({}), ...config });
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({}), endpoint({ path: '/items/:name' })] }), /Duplicate OpenAPI route/);
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ operationId: 'read' }), endpoint({ path: '/other', operationId: 'read' })] }), /Duplicate operation ID/);
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ auth: [{ missing: [] }] })] }), /Unknown auth method/);
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ response: z.string().transform(Number) })] }), /Cannot describe transform/);
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ query: z.object({ count: z.preprocess(Number, z.number()) }) })] }), /Cannot describe pipe/);
    let documented = endpoint({ response: { schema: z.instanceof(Buffer).meta({ jsonSchema: { type: 'string', format: 'binary' } }), contentType: 'application/octet-stream' } });
    assert.equal(generateOpenApi({ endpoints: [documented] }).paths['/items/{id}'].get.responses[200].content['application/octet-stream'].schema.format, 'binary');
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ requestBody: { description: 'Missing schema' } })] }), /documentation needs body/);
    assert.throws(() => generateOpenApi({ endpoints: [endpoint({ multipart: true, requestBody: { files: { type: 'object', minProperties: 1 } } })] }), /only supports/);
    assert.throws(() => endpoint({ security: [] }), /[Uu]nknown|[Uu]nsupported/);
    assert.throws(() => defineManualTestApp({ securitySchemes: {} }), /[Uu]nknown|[Uu]nsupported/);
    assert.throws(() => endpoint({ headers: z.object({ 'X-Uppercase': z.string() }) }), /lowercase/);
  });

  it('keeps private model views out of automatic components and preserves caller metadata', () => {
    let model = defineModel({
      name: 'Account', table: 'accounts',
      row: { id: field.public(z.string()), credential: field.private(z.string(), { sensitive: true }) },
      views: { summary: ['id'], internal: ['id', 'credential'] }
    });
    let example = JSON.parse('{"__proto__":{"label":"ordinary data"},"cricket":"ordinary field"}');
    let endpoint = defineEndpoint({
      method: 'get', path: '/accounts',
      response: { schema: model.public, example }, handler: () => ({ id: 'a' })
    });
    let docs = generateOpenApi({ models: [model], endpoints: [endpoint] });
    assert.deepEqual(Object.keys(docs.components.schemas), ['AccountPublic', 'AccountSummary']);
    assert.equal(JSON.stringify(docs).includes('credential'), false);
    let outputExample = docs.paths['/accounts'].get.responses[200].content['application/json'].example;
    assert.deepEqual(outputExample, example);
    example.__proto__.label = 'caller change';
    assert.equal(outputExample.__proto__.label, 'ordinary data');
    assert.equal(Object.isFrozen(example), false);
    assert.ok(Object.isFrozen(outputExample.__proto__));
  });

  it('rejects broken schema references and unsupported nested values before publishing docs', () => {
    let docsFor = response => generateOpenApi({ endpoints: [defineEndpoint({
      method: 'get', path: '/data', response, handler: () => ({})
    })] });
    for (let schema of [z.literal(undefined), z.literal(1n), z.object({ examples: z.custom() })])
      assert.throws(() => docsFor(schema), /Cannot describe/);
    assert.throws(() => generateOpenApi({ endpoints: [defineEndpoint({
      method: 'post', path: '/coercion', body: z.object({ count: z.coerce.number() }), handler: () => ({})
    })] }), /Cannot describe number coercion/);
    assert.throws(() => docsFor({ schema: { $ref: '#/components/schemas/Missing' } }), /Unresolved OpenAPI schema reference/);
    let recursive = z.object({ get children() { return z.array(recursive); } });
    assert.throws(() => docsFor(recursive), /OpenAPI schema references/);
    let schema = { type: 'object', properties: { child: { $ref: '#/paths/~1data/get/responses/200/content/application~1json/schema' } } };
    assert.deepEqual(docsFor({ schema }).paths['/data'].get.responses[200].content['application/json'].schema, schema);
    assert.throws(() => generateOpenApi({ authMethods: { oauth: { type: 'oauth2', flows: { authorizationCode: { scopes: {} } } } } }), /authorizationUrl/);
  });

  it('describes raw text requests and serves their declared response through HTTP', async () => {
    let endpoint = defineEndpoint({
      method: 'post', path: '/text', rawBody: true,
      requestBody: { contentType: 'text/plain', schema: { type: 'string' }, example: 'a message' },
      response: { schema: z.string(), contentType: 'text/plain' },
      handler: ({ request: incoming }) => withHeaders(respond(201, incoming.rawBody), { 'Content-Type': 'text/plain' })
    });
    let docs = generateOpenApi({ endpoints: [endpoint] }).paths['/text'].post;
    let runtime = await createTestRuntime(defineManualTestApp({ endpoints: [endpoint] }));
    try {
      let result = await request(runtime.runtime.app).post('/text').type('text').send(docs.requestBody.content['text/plain'].example);
      assert.equal(result.status, 201);
      assert.equal(result.text, 'a message');
      assert.match(result.headers['content-type'], /^text\/plain/);
      assert.equal(docs.responses[201].content['text/plain'].schema.type, 'string');
    } finally { await runtime.cleanup(); }
  });

  it('keeps public schema output reproducible through the CLI without starting application services', async () => {
    let args = ['bin/cricket.js', 'docs', 'test/fixtures/public-contract-docs.js'];
    let first = await execFileAsync(process.execPath, args);
    let second = await execFileAsync(process.execPath, args);
    assert.equal(first.stdout, second.stdout);
    let docs = JSON.parse(first.stdout);
    assert.equal(docs.components.securitySchemes.bearer.scheme, 'bearer');
    assert.deepEqual(docs.paths['/reports/{id}'].get.security, [{ bearer: [] }]);
    assert.equal(docs.paths['/reports/{id}'].get.parameters.find(item => item.in === 'header').name, 'x-client-version');
  });
});
