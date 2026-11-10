import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import knex from 'knex';

import {
  defineCricketApp,
  createCricketRuntime,
  defineEndpoint,
  defineRule,
  ok,
  startCricketApp,
  withHeaders,
  withResponseCleanup,
  z
} from '../src/index.js';
import { createTestClient, createTestRuntime } from '../src/test/index.js';
import { rawHttpResponse } from './fixtures/http.js';

function deferred() {
  let resolve;
  let promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function appWith(endpoints, options = {}) {
  return defineCricketApp({
    logger() {},
    domains: [{ name: 'requests', endpoints }],
    ...options
  });
}

function streamRequest(origin, { method = 'GET', headers, agent, body } = {}) {
  let started = deferred();
  let first = deferred();
  let outgoing;
  let completed = new Promise((resolve, reject) => {
    outgoing = http.request(origin, { method, headers, agent }, response => {
      let chunks = [];
      started.resolve(response);
      response.on('data', chunk => {
        chunks.push(chunk);
        first.resolve();
      });
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString()
      }));
      response.once('error', reject);
      response.once('close', () => {
        if (!response.complete) reject(new Error('Response closed before completion'));
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
  void completed.catch(() => {});
  return { outgoing, started: started.promise, first: first.promise, completed };
}

for (let complete of [false, true]) {
  test(`a disconnected ${complete ? 'complete' : 'partial'} POST settles after its auth rule finishes`, { timeout: 5000 }, async t => {
    let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-aborted-body-'));
    let entered = deferred(), release = deferred(), disconnected = deferred();
    let incoming;
    let runtime = await createCricketRuntime(appWith([
      defineEndpoint({
        method: 'post', path: '/writes', body: z.object({ value: z.string() }),
        beforeBodyRules: [defineRule('waitForAuth', async () => {
          entered.resolve();
          await release.promise;
        })],
        async handler({ db, input }) {
          await db('writes').insert(input.body);
          return ok({ saved: true });
        }
      }),
      defineEndpoint({
        method: 'get', path: '/writes',
        async handler({ db }) { return ok(await db('writes')); }
      })
    ], {
      database: { client: 'sqlite3', connection: { filename: path.join(directory, 'app.sqlite') }, useNullAsDefault: true },
      async setup({ db }) { await db.schema.createTable('writes', table => table.text('value')); }
    }));
    let server = http.createServer((req, res) => {
      incoming = req;
      res.once('close', () => disconnected.resolve());
      runtime.handle(req, res);
    });
    t.after(async () => {
      release.resolve();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await fs.rm(directory, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let origin = `http://127.0.0.1:${server.address().port}`;
    let outgoing = http.request(`${origin}/writes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    outgoing.on('error', () => {});
    if (complete) outgoing.end('{"value":"must not be saved"}');
    else outgoing.write('{"value":');
    await entered.promise;
    outgoing.destroy();
    await disconnected.promise;
    assert.equal(incoming.destroyed, true);
    let hold = runtime.requests.pause();
    release.resolve();
    await hold.idle({ signal: t.signal });
    hold.resume();
    assert.deepEqual(await (await fetch(`${origin}/writes`)).json(), []);
  });
}

test('independent holds block application work and an aborted idle can be awaited again', async t => {
  let stream = new PassThrough();
  let calls = 0;
  let app = appWith([defineEndpoint({
    method: 'get', path: '/', handler() { calls += 1; return ok(stream); }
  })]);
  let harness = await createTestRuntime(app);
  t.after(async () => { stream.end(); await harness.cleanup(); });
  let pending = streamRequest(harness.origin);
  stream.write('one');
  await pending.first;
  let first = harness.runtime.requests.pause();
  let second = harness.runtime.requests.pause();
  assert.equal(harness.runtime.lifecycle.phase(), 'ready');
  assert.equal(harness.runtime.lifecycle.isReady(), true);
  assert.equal(Object.isFrozen(first), true);
  let cancellation = new AbortController();
  let aborted = first.idle({ signal: cancellation.signal });
  cancellation.abort(new Error('owner canceled'));
  await assert.rejects(aborted, /owner canceled/);
  first.resume();
  first.resume();
  assert.equal((await harness.api.get('/')).status, 503);
  assert.equal(calls, 1);
  let idle = second.idle();
  stream.end(' two');
  assert.deepEqual(await pending.completed, { status: 200, body: 'one two' });
  await idle;
  await assert.rejects(first.idle(), /resumed request hold/);
  second.resume();
  // A fresh hold can be aborted before waiting without releasing admission.
  let third = harness.runtime.requests.pause();
  await assert.rejects(third.idle({ signal: cancellation.signal }), /owner canceled/);
  await third.idle();
  assert.equal((await harness.api.get('/')).status, 503);
  third.resume();
  assert.equal(harness.runtime.lifecycle.phase(), 'ready');
  assert.equal(harness.runtime.lifecycle.isReady(), true);
});

test('disconnected handlers and late async response cleanup finish before database destruction', async t => {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-lifetime-'));
  let database = {
    client: 'sqlite3', connection: { filename: path.join(directory, 'app.sqlite') }, useNullAsDefault: true
  };
  let entered = deferred();
  let releaseHandler = deferred();
  let cleanupEntered = deferred();
  let releaseCleanup = deferred();
  let destroyed = 0;
  let app = appWith([defineEndpoint({
    method: 'post', path: '/',
    async handler({ db }) {
      entered.resolve();
      await releaseHandler.promise;
      await db('writes').insert({ value: 'handler' });
      return withResponseCleanup(ok({ saved: true }), async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        await db('writes').insert({ value: 'response cleanup' });
      });
    }
  })], {
    database,
    async setup({ db }) {
      await db.schema.createTable('writes', table => table.text('value'));
      return { async cleanup() {
        assert.equal((await db('writes')).length, 2);
        destroyed += 1;
      } };
    }
  });
  let runtime = await startCricketApp(app, { port: 0, host: '127.0.0.1' });
  t.after(async () => {
    releaseHandler.resolve();
    releaseCleanup.resolve();
    await runtime.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let pending = streamRequest(runtime.origin, { method: 'POST' });
  await entered.promise;
  let disconnected = new Promise(resolve => pending.outgoing.once('close', resolve));
  pending.outgoing.destroy();
  await disconnected;
  let hold = runtime.requests.pause();
  let idle = hold.idle();
  let stopping = runtime.stop('test');
  releaseHandler.resolve();
  await cleanupEntered.promise;
  assert.equal(destroyed, 0);
  releaseCleanup.resolve();
  await Promise.all([idle, stopping, runtime.stop('test')]);
  assert.equal(destroyed, 1);
  let persisted = knex(database);
  try {
    assert.deepEqual((await persisted('writes')).map(row => row.value), ['handler', 'response cleanup']);
  } finally {
    await persisted.destroy();
  }
  hold.resume();
  let client = await createTestClient(runtime.app);
  try {
    assert.equal((await client.post('/')).status, 503);
  } finally {
    await client.cleanup();
  }
});

test('embedded runtime holds preserve outer control and join late stream destruction before database cleanup', async t => {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-embedded-lifetime-'));
  let database = {
    client: 'sqlite3', connection: { filename: path.join(directory, 'app.sqlite') }, useNullAsDefault: true
  };
  let handlerEntered = deferred();
  let releaseHandler = deferred();
  let destroyEntered = deferred();
  let releaseDestroy = deferred();
  let cleanupFinished = false;
  let runtime = await createCricketRuntime(appWith([defineEndpoint({
    method: 'get', path: '/',
    async handler({ db }) {
      handlerEntered.resolve();
      await releaseHandler.promise;
      let body = new Readable({
        read() {},
        destroy(error, callback) {
          destroyEntered.resolve();
          releaseDestroy.promise.then(async () => {
            try {
              await db('writes').insert({ value: 'stream destroyed' });
              callback(error);
            } catch (failure) {
              callback(failure);
            }
          });
        }
      });
      return ok(body);
    }
  })], {
    database,
    async setup({ db }) {
      await db.schema.createTable('writes', table => table.text('value'));
      return { async cleanup() {
        assert.deepEqual((await db('writes')).map(row => row.value), ['stream destroyed']);
        cleanupFinished = true;
      } };
    }
  }));
  let outer = http.createServer((req, res) => {
    if (req.url === '/control') {
      res.end('control is available');
      return;
    }
    runtime.handle(req, res);
  });
  outer.listen(0, '127.0.0.1');
  await once(outer, 'listening');
  let origin = `http://127.0.0.1:${outer.address().port}`;
  t.after(async () => {
    releaseHandler.resolve();
    releaseDestroy.resolve();
    await runtime.cleanup();
    await new Promise(resolve => outer.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  let pending = streamRequest(origin);
  await handlerEntered.promise;
  let disconnected = new Promise(resolve => pending.outgoing.once('close', resolve));
  pending.outgoing.destroy();
  await disconnected;

  let hold = runtime.requests.pause();
  let idle = hold.idle();
  assert.equal((await fetch(`${origin}/control`)).status, 200);
  assert.equal((await fetch(origin)).status, 503);

  releaseHandler.resolve();
  await destroyEntered.promise;
  let cleanup = runtime.cleanup();
  assert.equal(cleanupFinished, false);
  releaseDestroy.resolve();
  await Promise.all([idle, cleanup]);
  assert.equal(cleanupFinished, true);
  hold.resume();
});

test('successful responses retain async cleanup failures for one drain and preserve error-hook context', async t => {
  let cleanupEntered = deferred();
  let releaseCleanup = deferred();
  let errorEntered = deferred();
  let releaseError = deferred();
  let errors = [];
  let cleanupCalls = 0;
  let app = appWith([defineEndpoint({
    method: 'get', path: '/',
    handler() {
      return withResponseCleanup(ok({ saved: true }), async () => {
        cleanupCalls += 1;
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        throw new Error('response cleanup failed');
      });
    }
  })], {
    async onError(error, { request, response }) {
      errors.push({ message: error.message, path: request.path, status: response.status });
      errorEntered.resolve();
      await releaseError.promise;
    }
  });
  let harness = await createTestRuntime(app);
  t.after(async () => { releaseCleanup.resolve(); releaseError.resolve(); await harness.cleanup(); });
  assert.deepEqual((await harness.api.get('/')).body, { saved: true });
  await cleanupEntered.promise;
  let hold = harness.runtime.requests.pause();
  let rejected = assert.rejects(hold.idle(), /response cleanup failed/);
  releaseCleanup.resolve();
  await errorEntered.promise;
  assert.equal((await harness.api.get('/')).status, 503);
  releaseError.resolve();
  await rejected;
  assert.deepEqual(errors, [{ message: 'response cleanup failed', path: '/', status: 200 }]);
  assert.equal(cleanupCalls, 1);
  await hold.idle();
  hold.resume();
  let next = harness.runtime.requests.pause();
  await next.idle();
  next.resume();
});

test('producer failures reject draining while ordinary client stream cancellation does not', async t => {
  let stream = new PassThrough();
  let failure = new Error('producer failed');
  let observed = [];
  let app = appWith([defineEndpoint({ method: 'get', path: '/', handler: () => ok(stream) })], {
    onError(error) { observed.push(error); }
  });
  let harness = await createTestRuntime(app);
  t.after(async () => { stream.destroy(); await harness.cleanup(); });
  let pending = streamRequest(harness.origin);
  stream.write('ready');
  await pending.first;
  let hold = harness.runtime.requests.pause();
  let draining = assert.rejects(hold.idle(), error => error === failure);
  stream.destroy(failure);
  await assert.rejects(pending.completed);
  await draining;
  assert.deepEqual(observed, [failure]);
  await hold.idle();
  hold.resume();
  stream = new PassThrough();
  let canceled = streamRequest(harness.origin);
  stream.write('another response');
  let response = await canceled.started;
  await canceled.first;
  let next = harness.runtime.requests.pause();
  response.destroy();
  await assert.rejects(canceled.completed);
  await next.idle();
  assert.deepEqual(observed, [failure]);
  next.resume();
});

test('repeated HTTP completion failures retain bounded drain details without losing error reports', async t => {
  let reported = [];
  let requests = 0;
  let harness = await createTestRuntime(appWith([defineEndpoint({
    method: 'get', path: '/', handler() {
      let index = requests++;
      return withResponseCleanup(ok({ index }), () => {
        throw new Error(`cleanup ${index} failed`);
      });
    }
  })], {
    onError(error) { reported.push(error.message); }
  }));
  t.after(() => harness.cleanup());

  for (let index = 0; index < 80; index += 1)
    assert.deepEqual((await harness.api.get('/')).body, { index });

  let hold = harness.runtime.requests.pause();
  await assert.rejects(hold.idle(), error => {
    assert.equal(error.errors.length, 33);
    assert.deepEqual(error.errors.slice(0, 32).map(failure => failure.message),
      Array.from({ length: 32 }, (_, index) => `cleanup ${index} failed`));
    let summary = error.errors.at(-1);
    assert.equal(summary.code, 'REQUEST_FAILURES_SUPPRESSED');
    assert.equal(summary.count, 48);
    assert.match(summary.message, /48 additional request completion failures/);
    return true;
  });
  assert.equal(reported.length, 80);
  assert.equal(harness.testState.logs({ event: 'request.failed' }).length, 80);
  await hold.idle();
  hold.resume();
  let next = harness.runtime.requests.pause();
  await next.idle();
  next.resume();
});

test('shutdown ends keep-alive streams through the hook before releasing dependencies', async t => {
  let stream = new PassThrough();
  let events = [];
  let hook = deferred();
  let release = deferred();
  let app = appWith([defineEndpoint({ method: 'post', path: '/', body: z.object({}), handler() {
    return withResponseCleanup(ok(stream), () => events.push('response cleanup'));
  } })], {
    async onShutdown() {
      events.push('shutdown hook');
      hook.resolve();
      await release.promise;
      stream.end(' done');
    },
    setup() { return { cleanup() { events.push('dependency cleanup'); } }; }
  });
  let runtime = await startCricketApp(app, { port: 0, host: '127.0.0.1' });
  runtime.server.keepAliveTimeout = 0;
  let agent = new http.Agent({ keepAlive: true });
  t.after(async () => { release.resolve(); stream.end(); agent.destroy(); await runtime.stop(); });
  let pending = streamRequest(runtime.origin, {
    method: 'POST', agent, body: '{}',
    headers: { 'content-type': 'application/json' }
  });
  stream.write('ready');
  let response = await pending.started;
  await pending.first;
  assert.equal(response.headers.connection, 'keep-alive');
  assert.deepEqual(events, []); // Completing the incoming request is not response cleanup.
  let stopping = runtime.stop('test');
  await hook.promise;
  // Admission also closes for a handler embedded in another owned listener.
  let client = await createTestClient(runtime.app);
  try {
    assert.equal((await client.post('/', { body: {} })).status, 503);
  } finally {
    await client.cleanup();
  }
  release.resolve();
  assert.deepEqual(await pending.completed, { status: 200, body: 'ready done' });
  await stopping;
  assert.deepEqual(events, ['shutdown hook', 'response cleanup', 'dependency cleanup']);
});

test('response preparation and discarded HEAD streams still join asynchronous cleanup', async t => {
  let release = deferred();
  let entered = deferred();
  let events = [];
  let endpoints = ['invalid', 'head'].map(name => defineEndpoint({
    method: 'get', path: `/${name}`, handler() {
      let response = ok(Readable.from(['unused']));
      if (name === 'invalid') response = withHeaders(response, { 'content-length': '7' });
      return withResponseCleanup(response, async () => {
        entered.resolve();
        await release.promise;
        events.push(name);
      });
    }
  }));
  let harness = await createTestRuntime(appWith(endpoints));
  t.after(async () => { release.resolve(); await harness.cleanup(); });
  let response = await harness.api.request('HEAD', '/invalid');
  assert.equal(response.status, 500);
  await entered.promise;
  assert.equal((await harness.api.request('HEAD', '/head')).status, 200);
  let hold = harness.runtime.requests.pause();
  let idle = hold.idle();
  assert.deepEqual(events, []);
  release.resolve();
  await idle;
  assert.deepEqual(events, ['invalid', 'head']);
  hold.resume();
});

test('terminal observers and awaited middleware unwind remain inside a request hold', async t => {
  let middlewareEntered = deferred();
  let releaseMiddleware = deferred();
  let observerEntered = deferred();
  let releaseObserver = deferred();
  let events = [];
  let harness = await createTestRuntime(appWith([defineEndpoint({
    method: 'get', path: '/', handler: () => ({ ready: true })
  })], {
    middleware: [async (context, next) => {
      let result = await next(context);
      middlewareEntered.resolve();
      await releaseMiddleware.promise;
      events.push('middleware');
      return result;
    }],
    async observability(event) {
      if (event.type !== 'response.finished') return;
      observerEntered.resolve();
      await releaseObserver.promise;
      events.push('observer');
    }
  }));
  t.after(async () => { releaseMiddleware.resolve(); releaseObserver.resolve(); await harness.cleanup(); });
  let response = harness.api.get('/');
  await middlewareEntered.promise;
  let hold = harness.runtime.requests.pause();
  let idle = hold.idle();
  releaseMiddleware.resolve();
  assert.equal((await response).status, 200);
  await observerEntered.promise;
  assert.deepEqual(events, ['middleware']);
  releaseObserver.resolve();
  await idle;
  assert.deepEqual(events, ['middleware', 'observer']);
  hold.resume();
});

test('failed binding releases runtime dependencies and successful startup reports a usable origin', async t => {
  let blocker = http.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  let cleanupCalls = 0;
  let signals = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  let app = appWith([], { setup() { return { cleanup() { cleanupCalls += 1; } }; } });
  await assert.rejects(startCricketApp(app, {
    port: blocker.address().port, host: '127.0.0.1'
  }), { code: 'EADDRINUSE' });
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), signals);
  let logs = [];
  let runtime = await startCricketApp(app, {
    port: 0, host: '127.0.0.1', logger: { write: line => logs.push(JSON.parse(line)) }
  });
  t.after(() => runtime.stop());
  assert.equal(runtime.server.listening, true);
  assert.equal((await fetch(runtime.origin)).status, 404);
  assert.deepEqual(logs.find(log => log.event === 'server.started').metadata, {
    app: 'Cricket app', port: runtime.server.address().port, url: runtime.origin
  });
});

test('test cleanup is once-only, joins response cleanup, and omits standalone shutdown hooks', async () => {
  let release = deferred();
  let entered = deferred();
  let events = [];
  let harness = await createTestRuntime(appWith([defineEndpoint({
    method: 'get', path: '/', handler() {
      return withResponseCleanup(ok({ ready: true }), async () => {
        entered.resolve();
        await release.promise;
        events.push('response cleanup');
      });
    }
  })], {
    onShutdown() { events.push('shutdown hook'); },
    setup() { return { cleanup() { events.push('dependency cleanup'); } }; }
  }));
  assert.equal(harness.origin, harness.api.origin);
  assert.equal((await fetch(harness.origin)).status, 200);
  await entered.promise;
  let closing = harness.cleanup();
  release.resolve();
  await Promise.all([closing, harness.cleanup()]);
  assert.deepEqual(events, ['response cleanup', 'dependency cleanup']);
  assert.equal(harness.runtime.lifecycle.phase(), 'stopped');
});

test('unsupported expectations return 417 before app work and HEAD sends no body bytes', async t => {
  let calls = 0;
  let harness = await createTestRuntime(appWith([defineEndpoint({
    method: 'get', path: '/', handler() { calls += 1; return { ready: true }; }
  })]));
  t.after(() => harness.cleanup());
  let rejected = await rawHttpResponse(harness.runtime.app, [
    'GET / HTTP/1.1', 'Host: localhost', 'Expect: unsupported', 'Connection: close', '', ''
  ].join('\r\n'));
  assert.match(rejected, /^HTTP\/1\.1 417 Expectation Failed\r\n/);
  assert.doesNotMatch(rejected, /100 Continue/);
  assert.equal(calls, 0);
  let head = await rawHttpResponse(harness.runtime.app, [
    'HEAD / HTTP/1.1', 'Host: localhost', 'Connection: close', '', ''
  ].join('\r\n'));
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(head.slice(head.indexOf('\r\n\r\n') + 4), '');
  assert.equal(calls, 1);
  let hold = harness.runtime.requests.pause();
  await hold.idle();
  hold.resume();
});

test('Expect: 100-continue uses the same response cleanup and admission boundary', async t => {
  let entered = deferred();
  let release = deferred();
  let harness = await createTestRuntime(appWith([defineEndpoint({
    method: 'post', path: '/', body: z.object({}), handler() {
      return withResponseCleanup(ok({ uploaded: true }), async () => {
        entered.resolve();
        await release.promise;
      });
    }
  })]));
  t.after(async () => { release.resolve(); await harness.cleanup(); });
  function upload() {
    return new Promise((resolve, reject) => {
      let request = http.request(harness.origin, {
        method: 'POST', headers: {
          expect: '100-continue', 'content-type': 'application/json', 'content-length': '2'
        }
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
        response.once('error', reject);
      });
      request.once('continue', () => request.end('{}'));
      request.once('error', reject);
      request.flushHeaders();
    });
  }
  assert.equal(await upload(), 200);
  await entered.promise;
  let hold = harness.runtime.requests.pause();
  let idle = hold.idle();
  assert.equal(await upload(), 503);
  release.resolve();
  await idle;
  hold.resume();
});

test('startup and terminal cleanup preserve every owned failure while releasing once', async () => {
  await assert.rejects(createCricketRuntime(appWith([], {
    setup() { return { cleanup() { throw new Error('assembly cleanup failed'); } }; },
    middleware() { throw new Error('middleware setup failed'); }
  })), error => {
    assert.deepEqual(error.errors.map(failure => failure.message), [
      'middleware setup failed', 'assembly cleanup failed'
    ]);
    return true;
  });
  let events = [];
  let runtime = await startCricketApp(appWith([defineEndpoint({
    method: 'get', path: '/', handler() {
      return withResponseCleanup(ok({ ready: true }), async () => {
        throw new Error('response cleanup failed');
      });
    }
  })], {
    onShutdown() { events.push('hook'); throw new Error('shutdown failed'); },
    setup() { return { cleanup() { events.push('cleanup'); throw new Error('dependency cleanup failed'); } }; }
  }), { port: 0, host: '127.0.0.1' });
  assert.equal((await fetch(runtime.origin)).status, 200);
  let stopping = runtime.stop('test');
  assert.equal(runtime.stop('test'), stopping);
  await assert.rejects(stopping, error => {
    assert.deepEqual(error.errors.map(failure => failure.message), [
      'shutdown failed', 'response cleanup failed', 'dependency cleanup failed'
    ]);
    return true;
  });
  assert.deepEqual(events, ['hook', 'cleanup']);
  assert.equal(runtime.lifecycle.phase(), 'stopped');
});
