import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCricketApp } from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';
import { app as quickstart } from '../examples/docs-start.js';
import { app as fetchExample } from '../examples/fetch-endpoint.js';
import { app as downloadExample } from '../examples/known-length-stream.js';
import { app as proxyExample } from '../examples/trusted-proxy.js';
import { app as temperatureExample } from '../examples/temperature.js';
import { createSession } from '../examples/versioned-api.js';

// The guides quote these examples, so they need to keep working.
import '../examples/projects/api/domains/projects/behavior.test.js';

async function start(t, app) {
  let { api, cleanup } = await createTestRuntime(app);
  t.after(cleanup);
  return api;
}

test('the quickstart route answers', async t => {
  let api = await start(t, quickstart);
  let response = await api.get('/hello/Cricket');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: 'Hey, Cricket!' });
});

// The homepage demo mirrors these exact bodies in the browser
// (site/src/components/Hero.astro), so a change here means updating it too.
test('the homepage temperature demo answers and rejects', async t => {
  let api = await start(t, temperatureExample);
  let rejected = async chirps => (await api.get('/temperature', { query: { chirps } })).body.error.issues;

  assert.deepEqual((await api.get('/temperature', { query: { chirps: '120' } })).body, { fahrenheit: 70 });
  assert.deepEqual(await rejected('abc'), [{ expected: 'number', code: 'invalid_type', received: 'NaN', path: ['chirps'], message: 'Invalid input: expected number, received NaN' }]);
  assert.deepEqual(await rejected('1.5'), [{ expected: 'int', format: 'safeint', code: 'invalid_type', path: ['chirps'], message: 'Invalid input: expected int, received number' }]);
  assert.deepEqual(await rejected('-3'), [{ origin: 'number', code: 'too_small', minimum: 0, inclusive: false, path: ['chirps'], message: 'Too small: expected number to be >0' }]);
});

test('the fetch example streams events', async t => {
  let api = await start(t, fetchExample);
  let response = await api.get('/events');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
});

test('the download example sends the whole file', async t => {
  let api = await start(t, downloadExample);
  let response = await api.get('/download', { query: { format: 'text' } });

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], '31');
});

test('the proxy example trusts forwarded headers from its proxy', async t => {
  // The test client connects from 127.0.0.1, which the example lists as its proxy.
  let api = await start(t, proxyExample);
  let response = await api.get('/connection', {
    headers: { 'x-forwarded-host': 'api.example.test', 'x-forwarded-proto': 'https' }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { origin: 'https://api.example.test', secure: true, proxyTrusted: true });
});

test('the versioned example still speaks the old format', async t => {
  let api = await start(t, defineCricketApp({
    domains: [{ name: 'sessions', endpoints: [createSession] }]
  }));

  let legacy = await api.post('/sessions', { body: { duration_seconds: 120 } });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.body, { session_id: 'session_123', duration_seconds: 120 });

  let current = await api.post('/sessions', {
    headers: { 'sessions-version': '2026-09-01' },
    body: { durationMinutes: 2 }
  });
  assert.deepEqual(current.body, { id: 'session_123', durationMinutes: 2 });
});
