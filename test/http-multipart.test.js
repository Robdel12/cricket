import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';
import request from 'supertest';

import {
  createCricketRuntime,
  defineEndpoint,
  defineRule,
  notFound,
  ok,
  respond,
  unauthenticated
} from '../src/index.js';
import { parseMultipartBody } from '../src/http/multipart.js';
import { defineManualTestApp } from '../test-support/app.js';
import { createHttpApp, rawHttpResponse } from './fixtures/http.js';

function deferred() {
  let resolve;
  let promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function readResponse(outgoing) {
  return new Promise((resolve, reject) => {
    outgoing.once('response', response => {
      let chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString()
      }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
  });
}

async function expectContinueRequest(runtime, headers, body) {
  let server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let port = server.address().port;
  let continued = false;
  let outgoing;

  try {
    let response = await new Promise((resolve, reject) => {
      outgoing = http.request({
        host: '127.0.0.1',
        port,
        path: '/uploads',
        method: 'POST',
        headers
      }, incoming => {
        let chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.once('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString()
        }));
        incoming.once('error', reject);
      });
      outgoing.once('error', reject);
      outgoing.once('continue', () => {
        continued = true;
        outgoing.end(body);
      });
      outgoing.flushHeaders();
    });
    return { ...response, continued };
  } finally {
    outgoing?.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function chunkedRequest(runtime, headers, body) {
  let server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let port = server.address().port;
  let outgoing;

  try {
    return await new Promise((resolve, reject) => {
      outgoing = http.request({
        host: '127.0.0.1',
        port,
        path: '/uploads',
        method: 'POST',
        headers
      }, incoming => {
        let chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.once('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString()
        }));
        incoming.once('error', reject);
      });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  } finally {
    outgoing?.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('Cricket multipart requests', () => {
  it('parses repeated fields and files, then removes temporary files', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let uploadedPath;
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      maxBodyBytes: 1024 * 1024,
      multipart: {
        maxFieldBytes: 1024,
        maxFiles: 2,
        maxFields: 10,
        maxFileBytes: 1024,
        tempDir
      },
      handler: async ({ request: cricketRequest }) => {
        uploadedPath = cricketRequest.files[0].path;
        let files = await Promise.all(
          cricketRequest.files.map(async file => ({
            fieldName: file.fieldName,
            mimeType: file.mimeType,
            originalName: file.originalName,
            size: file.size,
            content: await readFile(file.path, 'utf8')
          }))
        );
        return ok({
          body: cricketRequest.body,
          files
        });
      }
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await request(app)
      .post('/uploads')
      .field('tag', 'first')
      .field('tag', 'second')
      .field('__proto__', 'plain field')
      .attach('screenshots', Buffer.from('image-bytes'), 'screen.png');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      body: {
        ['__proto__']: 'plain field',
        tag: ['first', 'second']
      },
      files: [{
        fieldName: 'screenshots',
        mimeType: 'image/png',
        originalName: 'screen.png',
        size: 11,
        content: 'image-bytes'
      }]
    });
    await assert.rejects(() => stat(uploadedPath), { code: 'ENOENT' });
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('rejects files over the endpoint limit and cleans up the temporary directory', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      multipart: {
        maxFiles: 1,
        maxFields: 1,
        maxFileBytes: 4,
        tempDir
      },
      handler: () => ok({ uploaded: true })
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await request(app)
      .post('/uploads')
      .attach('screenshots', Buffer.from('too large'), 'screen.png');

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('rejects malformed multipart headers without creating temporary files', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      multipart: { tempDir },
      handler: () => ok({ uploaded: true })
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await request(app)
      .post('/uploads')
      .set('content-type', 'multipart/form-data')
      .send('not multipart');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('uses the multipart byte limit for fixed-length requests', async () => {
    let elevenMegabytes = Buffer.alloc(11 * 1024 * 1024, 'a');
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      multipart: {
        maxBytes: 12 * 1024 * 1024,
        maxFileBytes: 12 * 1024 * 1024
      },
      handler: ({ request: cricketRequest }) => ok({
        size: cricketRequest.files[0].size
      })
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await request(app)
      .post('/uploads')
      .attach('screenshots', elevenMegabytes, 'screen.png');

    assert.equal(response.status, 200);
    assert.equal(response.body.size, elevenMegabytes.length);
  });

  it('applies runtime multipart byte and file limits before continuing or parsing', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-runtime-limits-'));
    let boundary = 'cricket-runtime-limit-boundary';
    let fileContent = Buffer.alloc(160, 97);
    let body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      operationId: 'uploadArchive',
      beforeBodyRules: [defineRule('requireUploadToken', ({ request }) => {
        if (request.headers['x-upload-token'] !== 'allowed')
          throw unauthenticated();
      })],
      multipart: {
        maxBytes: 2048,
        maxFileBytes: 2048,
        maxFiles: 1,
        maxFields: 5,
        maxParts: 6,
        tempDir
      },
      handler({ request: parsedRequest }) {
        return ok({ size: parsedRequest.files[0].size });
      }
    });
    let createRuntime = limits => createCricketRuntime(defineManualTestApp({
      endpoints: [endpoint],
      requestBodyLimits: { uploadArchive: limits }
    }), { logger() {} });
    let aggregateRuntime = await createRuntime({
      maxBytes: body.length - 1,
      maxFileBytes: 512
    });
    let fileRuntime = await createRuntime({
      maxBytes: body.length + 100,
      maxFileBytes: fileContent.length - 1
    });
    let acceptedRuntime = await createRuntime({
      maxBytes: body.length + 100,
      maxFileBytes: fileContent.length + 1
    });
    assert.equal(Object.isFrozen(aggregateRuntime.contract.requestBodyLimits), true);
    assert.equal(Object.isFrozen(aggregateRuntime.contract.requestBodyLimits.uploadArchive), true);
    assert.deepEqual(aggregateRuntime.contract.requestBodyLimits.uploadArchive, {
      maxBytes: body.length - 1,
      maxFileBytes: 512
    });
    t.after(async () => {
      await aggregateRuntime.cleanup();
      await fileRuntime.cleanup();
      await acceptedRuntime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });

    let expectHeaders = {
      expect: '100-continue',
      'content-length': body.length,
      'content-type': `multipart/form-data; boundary=${boundary}`
    };
    let unauthenticatedResponse = await expectContinueRequest(
      aggregateRuntime,
      expectHeaders,
      body
    );
    assert.equal(unauthenticatedResponse.status, 401);
    assert.equal(unauthenticatedResponse.continued, false);

    let oversizedResponse = await expectContinueRequest(
      aggregateRuntime,
      { ...expectHeaders, 'x-upload-token': 'allowed' },
      body
    );
    assert.equal(oversizedResponse.status, 413);
    assert.equal(oversizedResponse.continued, false);

    let streamedOversized = await chunkedRequest(aggregateRuntime, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-upload-token': 'allowed'
    }, body);
    assert.equal(streamedOversized.status, 413);
    assert.deepEqual(await readdir(tempDir), []);

    let fileTooLarge = await request(fileRuntime.app)
      .post('/uploads')
      .set('x-upload-token', 'allowed')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    assert.equal(fileTooLarge.status, 413);
    assert.deepEqual(await readdir(tempDir), []);

    let accepted = await request(acceptedRuntime.app)
      .post('/uploads')
      .set('x-upload-token', 'allowed')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body, { size: fileContent.length });
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('rejects request body limit entries that do not name multipart operations', async () => {
    assert.throws(() => defineManualTestApp({
      requestBodyLimits: { uploadArchive: { maxBytes: 0 } }
    }), /maxBytes must be a positive safe integer/);
    assert.throws(() => defineManualTestApp({
      requestBodyLimits: { uploadArchive: { maxBytes: 1024, maxFiles: 2 } }
    }), /unsupported keys: maxFiles/);

    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      operationId: 'uploadArchive',
      multipart: {},
      handler: () => ok({ uploaded: true })
    });
    await assert.rejects(createCricketRuntime(defineManualTestApp({
      endpoints: [endpoint],
      requestBodyLimits: { unknownUpload: { maxBytes: 1024 } }
    }), { logger() {} }), /unknown operation ID unknownUpload/);

    let fetchEndpoint = defineEndpoint({
      method: 'post',
      path: '/fetch',
      operationId: 'fetchUpload',
      fetchResponses: { 200: {} },
      fetch: () => new Response('ok')
    });
    await assert.rejects(createCricketRuntime(defineManualTestApp({
      endpoints: [fetchEndpoint],
      requestBodyLimits: { fetchUpload: { maxBytes: 1024 } }
    }), { logger() {} }), /requires a parsed multipart endpoint/);

    let app = defineManualTestApp({
      endpoints: [endpoint],
      requestBodyLimits: { uploadArchive: { maxBytes: 1024 } },
      setup() {
        return { services: { fromSetup: true } };
      }
    });
    await assert.rejects(createCricketRuntime({
      ...app,
      requestBodyLimits: { uploadArchive: { maxBytes: 1 } }
    }), /cannot replace requestBodyLimits/);

    let runtime = await createCricketRuntime({
      ...app,
      services({ services }) {
        return { ...services, fromApp: true };
      }
    }, { logger() {} });
    assert.equal(runtime.services.fromSetup, true);
    assert.equal(runtime.services.fromApp, true);
    await runtime.cleanup();
  });

  it('runs endpoint access rules before parsing or creating temporary files', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let requireToken = defineRule('requireToken', () => {
      throw unauthenticated();
    });
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      beforeBodyRules: [requireToken],
      multipart: { tempDir },
      handler: () => ok({ uploaded: true })
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await request(app)
      .post('/uploads')
      .set('content-type', 'multipart/form-data')
      .send('not multipart');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('closes a request rejected before its body is read', async () => {
    let requireToken = defineRule('requireToken', () => {
      throw unauthenticated();
    });
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      beforeBodyRules: [requireToken],
      multipart: {},
      handler: () => ok({ uploaded: true })
    });
    let app = await createHttpApp({ endpoints: [endpoint] });

    let response = await rawHttpResponse(app, [
      'POST /uploads HTTP/1.0',
      'Host: localhost',
      'Content-Type: multipart/form-data; boundary=unused',
      'Content-Length: 1000000',
      '',
      ''
    ].join('\r\n'));

    assert.match(response, /^HTTP\/1\.1 401/);
    assert.match(response, /Connection: close/i);
  });

  it('returns an early multipart rejection while the client is still writing', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let serverFinished = deferred();
    let source = new PassThrough();
    let responseReceived = deferred();
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 1024,
        multipart: { maxBytes: 1024, tempDir },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => {
      outgoing.once('finish', () => {
        // Continue the upload as the early response finishes, before the writer handles finish.
        source.write(Buffer.from('bcdefgh'));
        serverFinished.resolve({
          status: outgoing.statusCode,
          requestComplete: incoming.complete,
          contentLength: incoming.headers['content-length'],
          connection: outgoing.getHeader('connection')
        });
      });
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      releaseRule.resolve();
      source.destroy();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    let clientRequest = request(server)
      .post('/uploads')
      .set('Connection', 'keep-alive')
      .attach('file', source, {
        filename: 'upload.zip',
        contentType: 'application/zip',
        knownLength: 8
      });
    clientRequest.once('response', response => responseReceived.resolve({
      kind: 'response',
      status: response.status,
      body: response.body
    }));
    let clientPromise = (async () => {
      try {
        let response = await clientRequest;
        return {
          kind: 'response',
          status: response.status,
          body: response.body
        };
      } catch (error) {
        return {
          kind: 'error',
          code: error.code,
          responseStatus: error.response?.status
        };
      }
    })();
    await ruleEntered.promise;
    source.write(Buffer.from('a'));
    releaseRule.resolve();
    let finished = await serverFinished.promise;
    let responseBeforeBodyComplete = await Promise.race([
      responseReceived.promise,
      clientPromise
    ]);
    let hold = runtime.requests.pause();
    source.end();
    await hold.idle({ signal: t.signal });
    hold.resume();
    let clientOutcome = await clientPromise;
    let tempEntries = await readdir(tempDir);

    assert.equal(finished.status, 404);
    assert.equal(finished.requestComplete, false);
    assert.equal(finished.connection, 'keep-alive');
    assert.ok(Number(finished.contentLength) > 8);
    assert.deepEqual(responseBeforeBodyComplete, {
      kind: 'response',
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Build not found' } }
    });
    assert.deepEqual(clientOutcome, {
      kind: 'response',
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Build not found' } }
    });
    assert.deepEqual(tempEntries, []);
  });

  it('returns intact early responses for concurrent file-path uploads', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-concurrent-upload-'));
    let uploadPath = path.join(tempDir, 'large-upload.zip');
    await writeFile(uploadPath, Buffer.alloc(375_589, 'a'));
    let rejectUpload = defineRule('rejectUpload', () => {
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 512 * 1024,
        multipart: { maxBytes: 512 * 1024, tempDir },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => runtime.handle(incoming, outgoing));
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    let responses = await Promise.all(Array.from({ length: 8 }, () => request(server)
      .post('/uploads')
      .attach('file', uploadPath)));

    assert.deepEqual(responses.map(response => [response.status, response.body]),
      Array.from({ length: 8 }, () => [404, { error: { code: 'NOT_FOUND', message: 'Build not found' } }]));
    assert.deepEqual(await readdir(tempDir), ['large-upload.zip']);
  });

  it('keeps a keep-alive connection usable after draining an early rejection', async t => {
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let writes = 0;
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [
        defineEndpoint({
          method: 'post',
          path: '/uploads',
          beforeBodyRules: [rejectUpload],
          maxBodyBytes: 1024,
          handler: () => ok({ uploaded: true })
        }),
        defineEndpoint({
          method: 'get',
          path: '/next',
          handler() {
            writes += 1;
            return ok({ writes });
          }
        })
      ]
    }));
    let server = http.createServer((incoming, outgoing) => runtime.handle(incoming, outgoing));
    let agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    t.after(async () => {
      releaseRule.resolve();
      agent.destroy();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let origin = `http://127.0.0.1:${server.address().port}`;
    let outgoing = http.request(`${origin}/uploads`, {
      method: 'POST',
      agent,
      headers: {
        Connection: 'keep-alive',
        'Content-Length': '8'
      }
    });
    outgoing.on('error', () => {});
    let earlyResponse = readResponse(outgoing);
    outgoing.write('a');
    await ruleEntered.promise;
    releaseRule.resolve();
    let rejected = await earlyResponse;

    assert.equal(rejected.status, 404);
    assert.equal(rejected.headers.connection, 'keep-alive');
    assert.deepEqual(JSON.parse(rejected.body), {
      error: { code: 'NOT_FOUND', message: 'Build not found' }
    });

    let requestFinished = once(outgoing, 'finish');
    outgoing.end('bcdefgh');
    await requestFinished;
    let nextResponse = await new Promise((resolve, reject) => {
      let next = http.get(`${origin}/next`, { agent }, response => {
        let chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString(),
          reusedSocket: next.reusedSocket
        }));
        response.once('error', reject);
      });
      next.once('error', reject);
    });

    assert.equal(nextResponse.status, 200);
    assert.deepEqual(JSON.parse(nextResponse.body), { writes: 1 });
    assert.equal(nextResponse.reusedSocket, true);
    assert.equal(writes, 1);
  });

  it('releases a request hold when a client aborts an early discard', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-aborted-discard-'));
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let socketClosed = deferred();
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 1024,
        multipart: { maxBytes: 1024, tempDir },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => {
      incoming.socket.once('close', () => socketClosed.resolve());
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      releaseRule.resolve();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let outgoing = http.request(`http://127.0.0.1:${server.address().port}/uploads`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        'Content-Length': '1000'
      }
    });
    outgoing.on('error', () => {});
    let earlyResponse = readResponse(outgoing);
    outgoing.write('a');
    await ruleEntered.promise;
    releaseRule.resolve();
    let response = await earlyResponse;
    let hold = runtime.requests.pause();
    let idle = hold.idle({ signal: t.signal });

    assert.equal(response.status, 404);
    outgoing.destroy();
    await socketClosed.promise;
    await idle;
    hold.resume();
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('settles a stalled discard when the Node server request timeout closes it', async t => {
    let socketClosed = deferred();
    let rejectUpload = defineRule('rejectUpload', () => {
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 1024,
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer({
      connectionsCheckingInterval: 25,
      requestTimeout: 250
    }, (incoming, outgoing) => {
      incoming.socket.once('close', () => socketClosed.resolve());
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let outgoing = http.request(`http://127.0.0.1:${server.address().port}/uploads`, {
      method: 'POST',
      headers: {
        Connection: 'keep-alive',
        'Content-Length': '1000'
      }
    });
    outgoing.on('error', () => {});
    let response = readResponse(outgoing);
    outgoing.write('a');
    let early = await response;
    let hold = runtime.requests.pause();
    let idle = hold.idle({ signal: t.signal });

    assert.equal(early.status, 404);
    await socketClosed.promise;
    await idle;
    hold.resume();
  });

  it('stops an early discard at the endpoint body limit', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-limited-discard-'));
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let socketClosed = deferred();
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 64,
        multipart: { maxBytes: 64, tempDir },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => {
      incoming.socket.once('close', () => socketClosed.resolve());
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      releaseRule.resolve();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let outgoing = http.request(`http://127.0.0.1:${server.address().port}/uploads`, {
      method: 'POST',
      headers: {
        Connection: 'keep-alive',
        'Content-Length': '1000'
      }
    });
    outgoing.on('error', () => {});
    let earlyResponse = readResponse(outgoing);
    outgoing.write(Buffer.alloc(65, 'a'));
    await ruleEntered.promise;
    releaseRule.resolve();
    let response = await earlyResponse;

    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: 'NOT_FOUND', message: 'Build not found' }
    });
    await socketClosed.promise;
    let hold = runtime.requests.pause();
    await hold.idle({ signal: t.signal });
    hold.resume();
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('counts parser-consumed bytes toward the discard limit', async t => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-parser-limit-'));
    let socketClosed = deferred();
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        maxBodyBytes: 128,
        multipart: { maxBytes: 128, maxFieldBytes: 4, tempDir },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => {
      incoming.socket.once('close', () => socketClosed.resolve());
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let initialBody = Buffer.from([
      '--unused',
      'Content-Disposition: form-data; name="field"',
      '',
      '0123456789',
      '--unused--',
      ''
    ].join('\r\n'));
    let outgoing = http.request(`http://127.0.0.1:${server.address().port}/uploads`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        'Content-Type': 'multipart/form-data; boundary=unused'
      }
    });
    outgoing.on('error', () => {});
    let responsePromise = readResponse(outgoing);
    outgoing.write(initialBody);
    let response = await responsePromise;

    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Multipart field field exceeds 4 bytes' }
    });
    outgoing.write(Buffer.alloc(80, 'x'));
    await socketClosed.promise;
    let hold = runtime.requests.pause();
    await hold.idle({ signal: t.signal });
    hold.resume();
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('keeps an early validation response when the discarded body exceeds its limit', async t => {
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let socketClosed = deferred();
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/uploads',
        beforeBodyRules: [rejectUpload],
        maxBodyBytes: 1,
        multipart: { maxBytes: 1 },
        handler: () => ok({ uploaded: true })
      })]
    }));
    let server = http.createServer((incoming, outgoing) => {
      incoming.socket.once('close', () => socketClosed.resolve());
      runtime.handle(incoming, outgoing);
    });
    t.after(async () => {
      releaseRule.resolve();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let outgoing = http.request(`http://127.0.0.1:${server.address().port}/uploads`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        'Content-Length': '1000'
      }
    });
    outgoing.on('error', () => {});
    let earlyResponse = readResponse(outgoing);
    outgoing.write('too large');
    await ruleEntered.promise;
    releaseRule.resolve();
    let response = await earlyResponse;

    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: 'NOT_FOUND', message: 'Build not found' }
    });
    await socketClosed.promise;
  });

  it('lets Node reject pipelined requests after a close-request upload before app side effects', async t => {
    let parserError = deferred();
    let ruleEntered = deferred();
    let releaseRule = deferred();
    let sideEffects = 0;
    let rejectUpload = defineRule('rejectUpload', async () => {
      ruleEntered.resolve();
      await releaseRule.promise;
      throw notFound('Build not found');
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      endpoints: [
        defineEndpoint({
          method: 'post',
          path: '/uploads',
          beforeBodyRules: [rejectUpload],
          maxBodyBytes: 1024,
          handler: () => ok({ uploaded: true })
        }),
        defineEndpoint({
          method: 'get',
          path: '/side-effect',
          handler() {
            sideEffects += 1;
            return ok({ sideEffects });
          }
        })
      ]
    }));
    let server = http.createServer((incoming, outgoing) => runtime.handle(incoming, outgoing));
    server.on('clientError', (error, clientSocket) => {
      parserError.resolve(error.code);
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    let socket;
    t.after(async () => {
      releaseRule.resolve();
      socket?.destroy();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let responseBytes = new Promise((resolve, reject) => {
      let chunks = [];
      socket = net.createConnection({
        host: '127.0.0.1',
        port: server.address().port
      }, () => {
        socket.write([
          'POST /uploads HTTP/1.1',
          'Host: localhost',
          'Connection: close',
          'Content-Length: 8',
          '',
          'a'
        ].join('\r\n'));
      });
      socket.on('data', chunk => chunks.push(chunk));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.once('error', reject);
    });
    await ruleEntered.promise;
    socket.write([
      'bcdefghGET /side-effect HTTP/1.1',
      'Host: localhost',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    releaseRule.resolve();
    let response = await responseBytes;
    let parserErrorCode = await parserError.promise;

    assert.equal(parserErrorCode, 'HPE_CLOSED_CONNECTION');
    assert.match(response, /^HTTP\/1\.1 404/);
    assert.match(response, /Build not found/);
    assert.equal(sideEffects, 0);
  });

  it('finishes an active streamed response after draining a close-request upload', async t => {
    let responseReady = deferred();
    let firstChunkSent = deferred();
    let requestDrained = deferred();
    let releaseResponseTail = deferred();
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger() {},
      middleware: [async (context, next) => {
        if (context.request.path !== '/early')
          return await next(context);

        responseReady.resolve();
        let body = Readable.from((async function* () {
          yield 'streamed ';
          firstChunkSent.resolve();
          await releaseResponseTail.promise;
          yield 'response body';
        })());
        return respond(418, body);
      }]
    }));
    let server = http.createServer((incoming, outgoing) => {
      incoming.once('end', () => requestDrained.resolve());
      runtime.handle(incoming, outgoing);
    });
    let socket;
    let headersReceived = deferred();
    let firstResponseChunkReceived = deferred();
    let responseBytes;
    t.after(async () => {
      releaseResponseTail.resolve();
      socket?.destroy();
      server.closeAllConnections();
      if (server.listening)
        await new Promise(resolve => server.close(resolve));
      await runtime.cleanup();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    responseBytes = new Promise((resolve, reject) => {
      let chunks = [];
      let receivedHeaders = false;
      socket = net.createConnection({
        host: '127.0.0.1',
        port: server.address().port
      }, () => {
        socket.write([
          'POST /early HTTP/1.1',
          'Host: localhost',
          'Connection: close',
          'Content-Length: 8',
          '',
          'a'
        ].join('\r\n'));
      });
      socket.on('data', chunk => {
        chunks.push(chunk);
        let text = Buffer.concat(chunks).toString();
        let headerEnd = text.indexOf('\r\n\r\n');
        if (headerEnd < 0)
          return;

        if (!receivedHeaders) {
          receivedHeaders = true;
          headersReceived.resolve(text.slice(0, headerEnd));
        }

        if (text.slice(headerEnd + 4).includes('streamed '))
          firstResponseChunkReceived.resolve();
      });
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.once('error', reject);
    });
    await responseReady.promise;
    let headers = await headersReceived.promise;
    await firstChunkSent.promise;
    await firstResponseChunkReceived.promise;
    socket.write('bcdefgh');
    await requestDrained.promise;
    releaseResponseTail.resolve();
    let response = await responseBytes;

    assert.match(headers, /^HTTP\/1\.1 418/, response);
    assert.match(headers, /Connection: keep-alive/i);
    assert.match(response, /9\r\nstreamed \r\nd\r\nresponse body\r\n0\r\n\r\n$/);
  });

  it('stops active file writes and cleans up when a request aborts', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let boundary = 'cricket-aborted-upload';
    let incoming = new PassThrough();
    incoming.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`
    };
    incoming.complete = false;
    let parsed = parseMultipartBody(incoming, {
      maxBytes: 1024,
      tempDir
    });

    await once(incoming, 'resume');
    incoming.write([
      `--${boundary}`,
      'Content-Disposition: form-data; name="screenshots"; filename="screen.png"',
      'Content-Type: image/png',
      '',
      'partial image bytes'
    ].join('\r\n'));
    incoming.emit('aborted');

    await assert.rejects(parsed, { code: 'BAD_REQUEST' });
    assert.deepEqual(await readdir(tempDir), []);
  });

  it('rejects aggregate overflow without waiting for the sender to finish', async () => {
    let tempDir = await mkdtemp(path.join(os.tmpdir(), 'cricket-test-'));
    let boundary = 'cricket-oversized-upload';
    let incoming = new PassThrough();
    incoming.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`
    };
    incoming.complete = false;
    let parsed = parseMultipartBody(incoming, {
      maxBytes: 32,
      tempDir
    });

    await once(incoming, 'resume');
    incoming.write(Buffer.alloc(64, 'a'));

    await assert.rejects(parsed, { code: 'PAYLOAD_TOO_LARGE' });
    assert.deepEqual(await readdir(tempDir), []);
  });
});
