import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRuntime } from '@robdel12/cricket/test';
import { app } from '../../index.js';

async function start(t) {
  let { api, runtime, cleanup } = await createTestRuntime(app);
  t.after(cleanup);
  await runtime.dependencies.db.migrate.latest();
  return api;
}

let asAda = { headers: { authorization: 'Bearer ada' } };

test('creates a project and reads it back', async t => {
  let api = await start(t);

  let create = await api.post('/api/projects', {
    ...asAda,
    body: { slug: 'launch-plan', name: 'Launch plan' }
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.project.slug, 'launch-plan');
  assert.equal(create.body.project.owner_id, undefined);

  let read = await api.get('/api/projects/launch-plan', asAda);
  assert.equal(read.status, 200);
  assert.equal(read.body.project.name, 'Launch plan');
});

test('rejects bad input before the handler runs', async t => {
  let api = await start(t);
  let response = await api.post('/api/projects', { ...asAda, body: { slug: 'No Spaces', name: '' } });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
});

test('keeps projects private to their owner', async t => {
  let api = await start(t);
  await api.post('/api/projects', { ...asAda, body: { slug: 'secret', name: 'Secret' } });

  let response = await api.get('/api/projects/secret', { headers: { authorization: 'Bearer grace' } });
  assert.equal(response.status, 403);
});
