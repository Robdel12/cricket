import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { createCricketRuntime, defineEndpoint, generateOpenApi, tooManyRequests, z } from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';

async function startFetchApp(endpoint, appOptions = {}) {
  let runtime = await createCricketRuntime(defineManualTestApp({ ...appOptions, endpoints: [endpoint] }), { logger() {} });
  let server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    runtime,
    server,
    async close() {
      let cleanupError;
      try {
        await runtime.cleanup();
      } catch (error) {
        cleanupError = error;
      }
      if (server.listening)
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (cleanupError) throw cleanupError;
    }
  };
}

async function readResponse(response) {
  let chunks = [];
  for await (let chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('Fetch endpoints', () => {
  it('documents multiple Fetch response media types without buffering the body', () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/stream',
      responses: {
        200: { schema: z.unknown(), contentType: ['application/json', 'text/event-stream'] }
      },
      fetch: async () => new Response()
    });
    let docs = generateOpenApi({ endpoints: [endpoint] });
    assert.deepEqual(Object.keys(docs.paths['/stream'].post.responses[200].content), [
      'application/json', 'text/event-stream'
    ]);
  });

  it('keeps Fetch Request and Response transport details inside Cricket', async () => {
    let handlerRequest;
    let observedError;
    let app = await startFetchApp(defineEndpoint({
      method: 'get',
      path: '/fetch/:id',
      params: z.object({ id: z.string() }),
      beforeBodyRules: [({ request }) => {
        assert.equal(request.path, '/fetch/snapshot-1');
      }],
      responses: {
        202: { schema: z.string(), contentType: ['text/plain', 'text/event-stream'] }
      },
      fetch(request, context) {
        handlerRequest = request;
        assert.equal(request instanceof Request, true);
        assert.equal(context.request.params.id, 'snapshot-1');
        assert.ok(context.request.id);
        assert.equal(Object.hasOwn(context, 'req'), false);
        assert.equal(Object.hasOwn(context, 'res'), false);
        assert.equal(request.headers.get('x-hop'), null);
        let headers = new Headers({ 'content-type': 'text/plain' });
        headers.set('content-length', '17');
        headers.set('connection', 'x-private');
        headers.set('x-private', 'hidden');
        headers.append('set-cookie', 'first=1; Path=/; HttpOnly');
        headers.append('set-cookie', 'second=2; Path=/; HttpOnly');
        let body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('streamed '));
            controller.enqueue(new TextEncoder().encode('response'));
            controller.close();
          }
        });
        return new Response(body, { status: 202, headers });
      }
    }), { onError(error) { observedError = error; } });
    try {
      let response = await new Promise((resolve, reject) => {
        let request = http.get(`${app.origin}/fetch/snapshot-1`, {
          headers: { connection: 'x-hop', 'x-hop': 'hidden' }
        }, resolve);
        request.once('error', reject);
      });
      let responseBody = await readResponse(response);
      assert.equal(response.statusCode, 202, `${responseBody}\n${observedError?.stack}`);
      assert.equal(responseBody, 'streamed response');
      assert.equal(response.headers['content-length'], '17');
      assert.equal(response.headers['x-private'], undefined);
      assert.deepEqual(response.headers['set-cookie'], [
        'first=1; Path=/; HttpOnly', 'second=2; Path=/; HttpOnly'
      ]);
      assert.equal(handlerRequest.signal.aborted, false);
      let wrongMethod = await fetch(`${app.origin}/fetch/snapshot-1`, { method: 'POST' });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, OPTIONS');
    } finally {
      await app.close();
    }
  });

  it('preserves HEAD metadata while cancelling the Fetch response body without reading it', async () => {
    let cancelledResolve;
    let cancelled = new Promise(resolve => { cancelledResolve = resolve; });
    let pulls = 0;
    let app = await startFetchApp(defineEndpoint({
      method: 'head',
      path: '/head',
      responses: { 200: { schema: z.string(), contentType: 'text/plain' } },
      fetch: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('hello')); },
        pull() { pulls += 1; },
        cancel() { cancelledResolve(); }
      }), {
        headers: { 'content-type': 'text/plain', 'content-length': '5' }
      })
    }));
    try {
      let response = await new Promise((resolve, reject) => {
        let request = http.request(`${app.origin}/head`, { method: 'HEAD' }, resolve);
        request.once('error', reject);
        request.end();
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-length'], '5');
      assert.equal(await readResponse(response), '');
      await cancelled;
      assert.equal(pulls, 0);
    } finally {
      await app.close();
    }
  });

  it('enforces a body limit while the Fetch handler reads the web stream', async () => {
    let app = await startFetchApp(defineEndpoint({
      method: 'post',
      path: '/fetch',
      maxBodyBytes: 4,
      fetch: async request => new Response(await request.text())
    }));
    try {
      let response = await fetch(`${app.origin}/fetch`, { method: 'POST', body: '12345' });
      assert.equal(response.status, 413);
      assert.match(await response.text(), /Request body exceeds 4 bytes/);
      let continued = false;
      let expectedResponse = await new Promise((resolve, reject) => {
        let request = http.request({
          host: '127.0.0.1', port: new URL(app.origin).port, path: '/fetch', method: 'POST',
          headers: { expect: '100-continue', 'content-length': '5' }
        }, resolve);
        request.once('error', reject);
        request.once('continue', () => {
          continued = true;
          request.end('12345');
        });
        request.flushHeaders();
      });
      assert.equal(continued, false);
      assert.equal(expectedResponse.statusCode, 413);
      assert.match(await readResponse(expectedResponse), /Request body exceeds 4 bytes/);
    } finally {
      await app.close();
    }
  });

  it('keeps an upload readable after the Fetch handler returns when the response consumes it', async () => {
    let handlerReturnedResolve;
    let handlerReturned = new Promise(resolve => { handlerReturnedResolve = resolve; });
    let allowReadResolve;
    let allowRead = new Promise(resolve => { allowReadResolve = resolve; });
    let app = await startFetchApp(defineEndpoint({
      method: 'post',
      path: '/echo',
      fetch(request) {
        let reader;
        let body = new ReadableStream({
          async pull(controller) {
            if (!reader) {
              await allowRead;
              reader = request.body.getReader();
            }
            let result = await reader.read();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          }
        });
        let response = new Response(body);
        handlerReturnedResolve();
        return response;
      }
    }));
    try {
      let responsePromise = fetch(`${app.origin}/echo`, { method: 'POST', body: 'delayed request stream' });
      await handlerReturned;
      allowReadResolve();
      let response = await responsePromise;
      assert.equal(await response.text(), 'delayed request stream');
    } finally {
      allowReadResolve();
      await app.close();
    }
  });

  it('does not race a second body reader against an ignored incomplete upload', async () => {
    let app = await startFetchApp(defineEndpoint({
      method: 'post',
      path: '/early',
      maxBodyBytes: 1024,
      fetch: async () => new Response('early response')
    }));
    let request;
    try {
      let response = await new Promise((resolve, reject) => {
        request = http.request({
          host: '127.0.0.1',
          port: new URL(app.origin).port,
          path: '/early',
          method: 'POST',
          headers: { 'content-length': '100' }
        }, resolve);
        request.once('error', reject);
        request.flushHeaders();
        request.write('partial');
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers.connection, 'close');
      assert.equal(await readResponse(response), 'early response');
    } finally {
      request?.destroy();
      await app.close();
    }
  });

  it('holds a slow Fetch response reader to one bounded chunk and cancels its producer on disconnect', async () => {
    let pullStartedResolve;
    let pullStarted = new Promise(resolve => { pullStartedResolve = resolve; });
    let cancelResolve;
    let cancelled = new Promise(resolve => { cancelResolve = resolve; });
    let releasePullResolve;
    let releasePull = new Promise(resolve => { releasePullResolve = resolve; });
    let emitted = 0;
    let app = await startFetchApp(defineEndpoint({
      method: 'get',
      path: '/slow',
      fetch: () => new Response(new ReadableStream({
        start(controller) {
          emitted += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        async pull() {
          pullStartedResolve();
          await releasePull;
        },
        cancel() {
          cancelResolve();
          releasePullResolve();
        }
      }))
    }));
    try {
      let response = await fetch(`${app.origin}/slow`);
      let reader = response.body.getReader();
      let firstBytes = 0;
      while (firstBytes < 64 * 1024) {
        let first = await reader.read();
        assert.equal(first.done, false);
        firstBytes += first.value.byteLength;
      }
      assert.equal(firstBytes, 64 * 1024);
      await pullStarted;
      assert.equal(emitted, 1);
      await reader.cancel();
      await cancelled;
      await app.runtime.cleanup();
    } finally {
      releasePullResolve();
      await app.close();
    }
  });

  it('keeps the committed response status when a transferred upload later exceeds its limit', async () => {
    let app = await startFetchApp(defineEndpoint({
      method: 'post',
      path: '/echo',
      maxBodyBytes: 4,
      fetch: request => new Response(request.body, {
        headers: { 'content-type': 'text/plain', 'content-length': '6' }
      })
    }));
    let request;
    try {
      let response;
      let firstChunk;
      let closed;
      await new Promise((resolve, reject) => {
        request = http.request({
          host: '127.0.0.1',
          port: new URL(app.origin).port,
          path: '/echo',
          method: 'POST',
          headers: {
            expect: '100-continue',
            'content-type': 'text/plain'
          }
        }, incoming => {
          response = incoming;
          closed = new Promise(resolveClose => incoming.once('close', resolveClose));
          incoming.once('data', chunk => {
            firstChunk = chunk;
            request.end('56');
            resolve();
          });
        });
        request.once('error', error => {
          if (!response) reject(error);
        });
        request.once('continue', () => request.write('1234'));
        request.flushHeaders();
      });
      await closed;
      assert.equal(response.statusCode, 200);
      assert.equal(firstChunk.toString(), '1234');
      assert.equal(response.complete, false);
    } finally {
      request?.destroy();
      await app.close().catch(() => {});
    }
  });

  it('declines Expect bodies before upload when endpoint admission rejects', async () => {
    let app = await startFetchApp(defineEndpoint({
      method: 'post',
      path: '/fetch',
      beforeBodyRules: [() => { throw tooManyRequests('Slow down'); }],
      fetch: async () => new Response('unreachable')
    }));
    try {
      let continued = false;
      let response = await new Promise((resolve, reject) => {
        let request = http.request({
          host: '127.0.0.1',
          port: new URL(app.origin).port,
          path: '/fetch',
          method: 'POST',
          headers: { expect: '100-continue', 'content-length': '12' }
        }, resolve);
        request.once('error', reject);
        request.once('continue', () => {
          continued = true;
          request.end('should-not-upload');
        });
        request.flushHeaders();
      });
      assert.equal(continued, false);
      assert.equal(response.statusCode, 429);
      assert.match(await readResponse(response), /Slow down/);
    } finally {
      await app.close();
    }
  });

  it('aborts Fetch work on shutdown and joins it before releasing runtime resources', async () => {
    let enteredResolve;
    let entered = new Promise(resolve => { enteredResolve = resolve; });
    let cancelledResolve;
    let cancelled = new Promise(resolve => { cancelledResolve = resolve; });
    let fetchSignal;
    let app = await startFetchApp(defineEndpoint({
      method: 'get',
      path: '/fetch',
      fetch: request => {
        fetchSignal = request.signal;
        enteredResolve();
        let body = new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('first')); },
          pull() { return new Promise(() => {}); },
          cancel() { cancelledResolve(); }
        });
        return new Response(body);
      }
    }));
    try {
      let responsePromise = fetch(`${app.origin}/fetch`);
      await entered;
      let response = await responsePromise;
      let reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
      let cleanupFinished = false;
      let cleanup = app.runtime.cleanup().then(() => { cleanupFinished = true; });
      await cancelled;
      await cleanup;
      assert.equal(cleanupFinished, true);
      assert.equal(fetchSignal.aborted, true);
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it('aborts on client disconnect but keeps accepted handler work in the drain', async () => {
    let enteredResolve;
    let entered = new Promise(resolve => { enteredResolve = resolve; });
    let releaseResolve;
    let release = new Promise(resolve => { releaseResolve = resolve; });
    let signalAbortedResolve;
    let signalAborted = new Promise(resolve => { signalAbortedResolve = resolve; });
    let app = await startFetchApp(defineEndpoint({
      method: 'get',
      path: '/fetch',
      fetch: async request => {
        enteredResolve();
        request.signal.addEventListener('abort', signalAbortedResolve, { once: true });
        await release;
        return new Response('complete');
      }
    }));
    try {
      let request = http.get(`${app.origin}/fetch`, response => response.resume());
      request.once('error', () => {});
      await entered;
      request.destroy();
      await signalAborted;
      let cleanupFinished = false;
      let cleanup = app.runtime.cleanup().then(() => { cleanupFinished = true; });
      await Promise.resolve();
      assert.equal(cleanupFinished, false);
      releaseResolve();
      await cleanup;
      assert.equal(cleanupFinished, true);
    } finally {
      releaseResolve();
      await app.close();
    }
  });
});
