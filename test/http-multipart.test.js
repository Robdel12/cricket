import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import request from 'supertest';

import {
  createCricketRuntime,
  defineEndpoint,
  defineRule,
  notFound,
  ok,
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
      'POST /uploads HTTP/1.1',
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
        maxBodyBytes: 1,
        multipart: { maxBytes: 1, tempDir },
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
          contentLength: incoming.headers['content-length']
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
    await hold.idle();
    hold.resume();
    source.end();
    let clientOutcome = await clientPromise;
    let tempEntries = await readdir(tempDir);

    assert.equal(finished.status, 404);
    assert.equal(finished.requestComplete, false);
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
