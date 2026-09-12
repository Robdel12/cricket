import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defineApiVersions, defineCricketApp, defineEndpoint, defineRule,
  defineSerializer, generateOpenApi, ok, respond, unauthenticated, withHeaders, z
} from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';

let versions = defineApiVersions({
  name: 'comparison', header: 'Comparison-Version',
  current: 'current', default: 'legacy',
  versions: { legacy: {}, current: {} }
});
let Comparison = z.object({ id: z.string() });
let ScoredComparison = Comparison.extend({ score: z.number() });
let Summary = z.object({ kind: z.literal('summary'), comparison: Comparison });
let Score = z.object({ kind: z.literal('score'), comparison: ScoredComparison });
let History = z.object({
  kind: z.literal('history'), comparison: Comparison,
  history: z.array(Comparison)
});
let Current = z.discriminatedUnion('kind', [Summary, Score, History]);
let Legacy = z.object({ comparison: Comparison, history: z.array(Comparison) });
let Canonical = z.discriminatedUnion('loaded', [
  z.object({ loaded: z.literal('summary'), comparison: Comparison, internalSecret: z.string() }),
  z.object({ loaded: z.literal('score'), comparison: ScoredComparison, internalSecret: z.string() }),
  z.object({ loaded: z.literal('history'), comparison: Comparison, history: z.array(Comparison), internalSecret: z.string() })
]);
let currentSerializer = defineSerializer({
  name: 'comparison.current', output: Current,
  serialize: (value, { requirements }) => ({ ...value, kind: requirements.view })
});
let legacySerializer = defineSerializer({
  name: 'comparison.legacy', output: Legacy,
  serialize: value => value
});

function comparisonApp() {
  let loads = [];
  let earlyVersions = [];
  let handlerVersions = [];
  let requireAccess = defineRule('comparison.access', ({ request, apiVersion }) => {
    earlyVersions.push(apiVersion);
    if (request.headers.authorization !== 'Bearer fixture')
      throw unauthenticated();
  });
  let selectRequirements = defineRule('comparison.requirements', ({ apiVersion, input }) => ({
    requirements: { view: apiVersion === 'legacy' ? 'history' : input.query.view }
  }));
  // The service receives data requirements, never an API version.
  async function loadComparison(db, id, requirements) {
    loads.push(requirements.view);
    let columns = requirements.view === 'score' ? ['id', 'score'] : ['id'];
    let comparison = await db('comparisons').select(columns).where({ id }).first();
    let result = {
      loaded: requirements.view, comparison,
      internalSecret: 'canonical-only', unexpectedSecret: 'not in canonical schema'
    };
    if (requirements.view === 'history')
      result.history = await db('history').select('id');
    return result;
  }
  let endpoint = defineEndpoint({
    method: 'get', path: '/comparisons/:id', auth: [{ bearer: [] }],
    params: z.object({ id: z.string() }),
    query: z.object({ view: z.enum(['summary', 'score', 'history']).default('summary') }),
    beforeBodyRules: [requireAccess], rules: [selectRequirements],
    response: { schema: Canonical, serializer: currentSerializer },
    apiVersions: versions({ legacy: { response: legacySerializer } }),
    handler: async ({ db, input, requirements, apiVersion }) => {
      handlerVersions.push(apiVersion);
      return withHeaders(ok(await loadComparison(db, input.params.id, requirements)), {
        'X-Result': 'comparison'
      });
    }
  });
  let app = defineCricketApp({
    name: 'Projection fixture', authMethods: { bearer: { type: 'http', scheme: 'bearer' } },
    domains: [{ name: 'comparison', endpoints: [endpoint] }],
    context: () => ({ apiVersion: 'untrusted-context-value' }),
    database: { client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true },
    async setup({ db }) {
      await db.schema.createTable('comparisons', table => {
        table.string('id'); table.float('score');
      });
      await db.schema.createTable('history', table => table.string('id'));
      await db('comparisons').insert([{ id: 'good', score: 1.25 }, { id: 'incomplete', score: null }]);
      await db('history').insert({ id: 'previous' });
    }
  });
  return { app, endpoint, loads, earlyVersions, handlerVersions };
}

let auth = { Authorization: 'Bearer fixture' };
let currentHeaders = { ...auth, 'Comparison-Version': 'current' };

describe('Canonical response data and public projections', () => {
  it('preserves legacy history and loads only requested current facts through real HTTP and SQLite', async t => {
    let { app, endpoint, loads, earlyVersions, handlerVersions } = comparisonApp();
    let runtime = await createTestRuntime(app);
    t.after(() => runtime.cleanup());
    let historical = await runtime.api.get('/comparisons/good', { headers: auth });
    assert.equal(historical.status, 200);
    assert.deepEqual(historical.body, { comparison: { id: 'good' }, history: [{ id: 'previous' }] });
    assert.equal(historical.headers['comparison-version'], 'legacy');
    assert.match(historical.headers.vary, /Comparison-Version/i);

    let selectedHistory = await runtime.api.get('/comparisons/good?view=history', { headers: currentHeaders });
    assert.deepEqual(selectedHistory.body, { kind: 'history', comparison: { id: 'good' }, history: [{ id: 'previous' }] });

    // Current summary/score requests must work even when history is unavailable.
    await runtime.runtime.dependencies.db.schema.dropTable('history');
    let summary = await runtime.api.get('/comparisons/good', { headers: currentHeaders });
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, { kind: 'summary', comparison: { id: 'good' } });
    assert.equal(summary.headers['comparison-version'], 'current');
    assert.equal(summary.headers['x-result'], 'comparison');
    let score = await runtime.api.get('/comparisons/good?view=score', { headers: currentHeaders });
    assert.deepEqual(score.body, { kind: 'score', comparison: { id: 'good', score: 1.25 } });
    assert.deepEqual(loads, ['history', 'history', 'summary', 'score']);
    assert.deepEqual(earlyVersions, ['legacy', 'current', 'current', 'current']);
    assert.deepEqual(handlerVersions, earlyVersions);

    let currentDocs = generateOpenApi({ endpoints: [endpoint], authMethods: app.authMethods, apiVersions: { comparison: 'current' } });
    let legacyDocs = generateOpenApi({ endpoints: [endpoint], authMethods: app.authMethods });
    let currentSchema = currentDocs.paths['/comparisons/{id}'].get.responses[200].content['application/json'].schema;
    let legacySchema = legacyDocs.paths['/comparisons/{id}'].get.responses[200].content['application/json'].schema;
    assert.equal(currentSchema.oneOf?.length ?? currentSchema.anyOf?.length, 3);
    assert.deepEqual(legacySchema.required, ['comparison', 'history']);
    for (let docs of [currentDocs, legacyDocs]) {
      assert.equal(JSON.stringify(docs).includes('internalSecret'), false);
      assert.equal(JSON.stringify(docs).includes('loaded'), false);
      assert.deepEqual(docs.paths['/comparisons/{id}'].get.security, [{ bearer: [] }]);
    }
  });

  it('rejects missing selected facts, invalid selectors, and unauthorized or unsupported requests', async t => {
    let { app, loads } = comparisonApp();
    let runtime = await createTestRuntime(app);
    t.after(() => runtime.cleanup());
    let incomplete = await runtime.api.get('/comparisons/incomplete?view=score', { headers: currentHeaders });
    assert.equal(incomplete.status, 500);
    assert.equal(incomplete.body.error.code, 'RESPONSE_CONTRACT_FAILED');
    assert.equal(incomplete.body.error.issues, undefined);
    assert.equal((await runtime.api.get('/comparisons/good?view=secret', { headers: currentHeaders })).status, 422);
    assert.equal((await runtime.api.get('/comparisons/good', { headers: { 'Comparison-Version': 'current' } })).status, 401);
    assert.equal((await runtime.api.get('/comparisons/good', { headers: { ...auth, 'Comparison-Version': 'unknown' } })).status, 400);
    assert.deepEqual(loads, ['score']);
  });

  it('validates each status projection and falls back to its base serializer when a version has no override', async t => {
    let canonical = z.object({ name: z.string().transform(value => `${value}-validated`), internalSecret: z.string() });
    let small = defineSerializer({ name: 'small', output: z.object({ name: z.string() }), serialize: value => value });
    let old = defineSerializer({ name: 'old', output: z.object({ label: z.string() }), serialize: value => ({ label: value.name }) });
    let endpoint = defineEndpoint({
      method: 'post', path: '/results', query: z.object({ queued: z.string().optional() }),
      responses: { 200: { body: canonical, serializer: small }, 202: { schema: canonical, serializer: small } },
      apiVersions: versions({ legacy: { responses: { 200: old } } }),
      handler: ({ input }) => respond(input.query.queued ? 202 : 200, { name: 'result', internalSecret: 'never public' })
    });
    let runtime = await createTestRuntime(defineCricketApp({ domains: [{ name: 'result', endpoints: [endpoint] }] }));
    t.after(() => runtime.cleanup());
    assert.deepEqual((await runtime.api.post('/results')).body, { label: 'result-validated' });
    assert.deepEqual((await runtime.api.post('/results?queued=true')).body, { name: 'result-validated' });
    assert.deepEqual((await runtime.api.post('/results', { headers: currentHeaders })).body, { name: 'result-validated' });
    let responses = generateOpenApi({ endpoints: [endpoint] }).paths['/results'].post.responses;
    assert.deepEqual(responses[200].content['application/json'].schema.required, ['label']);
    assert.deepEqual(responses[202].content['application/json'].schema.required, ['name']);
  });

  it('checks the current serializer output after stripping unknown canonical fields', async t => {
    let received;
    let serializer = defineSerializer({
      name: 'missing.score', output: Score,
      serialize(value) { received = value; return { kind: 'score', comparison: { id: value.id } }; }
    });
    let endpoint = defineEndpoint({
      method: 'get', path: '/broken',
      response: { schema: z.object({ id: z.string() }), serializer },
      handler: () => ({ id: 'good', unexpectedSecret: 'must be stripped' })
    });
    let runtime = await createTestRuntime(defineCricketApp({ domains: [{ name: 'broken', endpoints: [endpoint] }] }));
    t.after(() => runtime.cleanup());
    let result = await runtime.api.get('/broken');
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'SERIALIZER_CONTRACT_FAILED');
    assert.equal(result.body.error.issues, undefined);
    assert.deepEqual(received, { id: 'good' });
  });

  it('rejects projections without canonical validation or a Cricket output contract', () => {
    let endpoint = response => defineEndpoint({ method: 'get', path: '/invalid', response, handler: () => ({}) });
    assert.throws(() => endpoint({ serializer: currentSerializer }), /canonical Zod schema/);
    assert.throws(() => endpoint({ schema: Canonical, serializer: value => value }), /Cricket serializer/);
  });
});
