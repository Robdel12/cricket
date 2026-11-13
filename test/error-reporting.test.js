import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';

import {
  badRequest,
  defineCricketApp,
  defineEndpoint,
  respond,
  withCookies,
  withError,
  withHeaders,
  withResponseCleanup,
  z
} from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';
import { sentryErrorHandler } from '@robdel12/cricket/sentry';
import { createHttpApp } from './fixtures/http.js';
import { app as errorReportingExample } from '../examples/error-reporting.js';

// Sentry is the external boundary; exercise Cricket through real HTTP requests.
function recordingSentry() {
  let events = [];
  let active;
  return {
    events,
    withScope(run) {
      let previous = active;
      active = { tags: {}, extra: {} };
      try {
        return run({
          setTags(values) { Object.assign(active.tags, values); },
          setExtras(values) { Object.assign(active.extra, values); }
        });
      } finally {
        active = previous;
      }
    },
    captureException(error) {
      events.push({ error, tags: { ...active.tags }, extra: { ...active.extra } });
    }
  };
}

test('handled failures retain the original error through response composition and validation', async () => {
  let original = new Error('private provider details');
  let calls = [];
  let cleaned = Promise.withResolvers();
  let app = await createHttpApp({
    endpoints: [defineEndpoint({
      method: 'get', path: '/provider', operationId: 'provider.read',
      responses: { 503: z.object({ error: z.string() }) },
      handler() {
        return withResponseCleanup(withCookies(withHeaders(
          withError(respond(503, { error: 'Try again later', private: 'not public' }), original),
          { 'X-Retry': 'yes' }
        ), [{ name: 'retry', value: 'yes' }]), () => cleaned.resolve());
      }
    })],
    onError(error, context) { calls.push({ error, context }); }
  });
  let response = await request(app).get('/provider');
  await cleaned.promise;
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'Try again later' });
  assert.equal(response.headers['x-retry'], 'yes');
  assert.match(response.headers['set-cookie'][0], /^retry=yes/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].error, original);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(calls[0].context.handled, true);
  assert.equal(calls[0].context.phase, 'request');
  assert.equal(calls[0].context.route.operationId, 'provider.read');
  assert(calls[0].context.request.id);
});

test('the documented custom hook example reports through the request logger', async t => {
  let harness = await createTestRuntime(errorReportingExample);
  t.after(() => harness.cleanup());
  let response = await harness.api.get('/provider');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'Try again later' });
  let report = harness.testState.logs().find(log => log.event === 'provider.failure');
  assert(report);
  assert.equal(report.metadata.operation, 'provider.read');
  assert.equal(report.metadata.status, 503);
  assert.equal(report.metadata.handled, true);
});

test('annotating an error never bypasses the endpoint response contract', async () => {
  let original = new Error('private provider details');
  let observed;
  let app = await createHttpApp({
    endpoints: [defineEndpoint({
      method: 'get', path: '/invalid-error-body',
      response: z.object({ saved: z.boolean() }),
      handler: () => withError(respond(503, { error: 'Try again later' }), original)
    })],
    onError(error) { observed = error; }
  });
  let response = await request(app).get('/invalid-error-body');
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'RESPONSE_CONTRACT_FAILED');
  assert.equal(response.body.error.message, 'Internal server error');
  assert.equal(observed.code, 'RESPONSE_CONTRACT_FAILED');
  assert.equal(JSON.stringify(response.body).includes(original.message), false);
});

test('early middleware responses can report failures before a route is matched', async () => {
  let original = new Error('credential database offline');
  let calls = [];
  let app = await createHttpApp({
    middleware: [() => withError(respond(500, { error: 'Unavailable' }), original)],
    onError(error, context) { calls.push({ error, context }); }
  });
  let response = await request(app).get('/private');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Unavailable' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].error, original);
  assert.equal(calls[0].context.request.path, '/private');
  assert.equal(calls[0].context.route, undefined);
});

test('a shared response is reported separately for concurrent requests without mutating it', async () => {
  let original = new Error('shared outage');
  let result = withError(respond(503, { error: 'Unavailable' }), original);
  let calls = [];
  let app = await createHttpApp({
    endpoints: [defineEndpoint({ method: 'get', path: '/outage', handler: () => result })],
    onError(error, { request }) { calls.push({ error, id: request.id }); }
  });
  let responses = await Promise.all([1, 2, 3].map(() => request(app).get('/outage')));
  assert(responses.every(response => response.status === 503));
  assert.equal(calls.length, 3);
  assert(calls.every(call => call.error === original));
  assert.equal(new Set(calls.map(call => call.id)).size, 3);
  assert.deepEqual(Object.keys(result), ['status', 'body']);
  assert.equal(JSON.stringify(result), '{"status":503,"body":{"error":"Unavailable"}}');
});

test('reporter failures never replace a handled HTTP response', async () => {
  let calls = 0;
  let app = await createHttpApp({
    endpoints: [defineEndpoint({
      method: 'get', path: '/unavailable',
      handler: () => withError(respond(503, { error: 'Unavailable' }), new Error('provider offline'))
    })],
    async onError() { calls++; throw new Error('reporter offline'); }
  });
  let response = await request(app).get('/unavailable');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'Unavailable' });
  assert.equal(calls, 1);
});

test('Sentry receives thrown and handled server errors without request credentials or payloads', async () => {
  let sentry = recordingSentry();
  let original = new Error('provider offline');
  let app = await createHttpApp({
    endpoints: [defineEndpoint({
      method: 'post', path: '/provider/:mode', operationId: 'provider.write',
      body: z.object({ secret: z.string() }),
      handler({ input }) {
        if (input.params.mode === 'thrown') throw original;
        return withError(respond(503, { error: 'Unavailable' }), original);
      }
    })],
    onError: sentryErrorHandler(sentry)
  });
  for (let mode of ['thrown', 'handled']) {
    let response = await request(app).post(`/provider/${mode}?secret=query-secret`)
      .set('Authorization', 'Bearer private-token')
      .set('Cookie', 'session=cookie-secret')
      .send({ secret: 'body-secret' });
    assert.equal(response.status, mode === 'thrown' ? 500 : 503);
  }
  assert.equal(sentry.events.length, 2);
  for (let event of sentry.events) {
    assert.equal(event.error, original);
    assert.equal(event.tags.framework, 'cricket');
    assert.equal(event.tags.operation, 'provider.write');
    assert.equal(event.tags.http_method, 'POST');
    assert(event.extra.requestId);
    assert.equal(event.extra.route, '/provider/:mode');
    assert.equal(event.error.message, 'provider offline');
    let captured = JSON.stringify({
      message: event.error.message, stack: event.error.stack,
      tags: event.tags, extra: event.extra
    });
    assert(!/private-token|cookie-secret|body-secret|query-secret/.test(captured));
    assert.equal(event.extra.path, undefined);
  }
  assert.equal(sentry.events[0].tags.error_handled, false);
  assert.equal(sentry.events[1].tags.error_handled, true);
});

test('Sentry omits unmatched request paths that may contain credentials', async () => {
  let sentry = recordingSentry();
  let app = await createHttpApp({
    middleware: [() => withError(respond(503, { error: 'Unavailable' }), new Error('auth offline'))],
    onError: sentryErrorHandler(sentry)
  });
  assert.equal((await request(app).get('/reset/private-reset-token')).status, 503);
  assert.equal(sentry.events.length, 1);
  assert(sentry.events[0].extra.requestId);
  assert.equal(sentry.events[0].extra.route, undefined);
  let event = sentry.events[0];
  assert(!JSON.stringify({ ...event, message: event.error.message, stack: event.error.stack })
    .includes('private-reset-token'));
});

test('Sentry ignores ordinary client failures, including deliberately handled responses', async () => {
  let sentry = recordingSentry();
  let app = await createHttpApp({
    endpoints: [defineEndpoint({
      method: 'get', path: '/invalid/:mode',
      handler({ input }) {
        let error = badRequest('Invalid page');
        if (input.params.mode === 'thrown') throw error;
        return withError(respond(400, { error: 'Invalid page' }), error);
      }
    })],
    onError: sentryErrorHandler(sentry)
  });
  for (let mode of ['thrown', 'handled'])
    assert.equal((await request(app).get(`/invalid/${mode}`)).status, 400);
  assert.deepEqual(sentry.events, []);
});

for (let status of [200, 400, 503]) {
  test(`Sentry reports later cleanup failures even when a ${status} response reuses the error`, async t => {
    let sentry = recordingSentry();
    let original = new Error('response cleanup failed');
    let cleanupEntered = Promise.withResolvers();
    let release = Promise.withResolvers();
    let harness = await createTestRuntime(defineCricketApp({
      logger() {},
      domains: [{ name: 'cleanup', endpoints: [defineEndpoint({
        method: 'get', path: '/saved', operationId: 'saved.read',
        handler() {
          let response = respond(status, { saved: true });
          if (status >= 400)
            response = withError(response, original);
          return withResponseCleanup(response, async () => {
            cleanupEntered.resolve();
            await release.promise;
            throw original;
          });
        }
      })] }],
      onError: sentryErrorHandler(sentry)
    }));
    t.after(async () => { release.resolve(); await harness.cleanup(); });
    assert.equal((await harness.api.get('/saved')).status, status);
    await cleanupEntered.promise;
    let hold = harness.runtime.requests.pause();
    let rejected = assert.rejects(hold.idle(), error => error === original);
    release.resolve();
    await rejected;
    assert.equal(sentry.events.length, status === 503 ? 2 : 1);
    let event = sentry.events.at(-1);
    assert.equal(event.error, original);
    assert.equal(event.tags.http_status, status);
    assert.equal(event.tags.error_phase, 'response');
    assert.equal(event.tags.operation, 'saved.read');
    await hold.idle();
    hold.resume();
  });
}

test('invalid reporting configuration and response annotations fail clearly', () => {
  assert.throws(() => defineCricketApp({ domains: [], onError: true }), /onError must be a function/);
  assert.throws(() => sentryErrorHandler({}), /Sentry SDK/);
  assert.throws(() => withError({ status: 500 }, new Error('oops')), /Cricket HTTP response/);
  assert.throws(() => withError(respond(200, {}), new Error('oops')), /status 400 or above/);
  assert.throws(() => withError(respond(500, {}), null), /needs an error/);
});
