import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

import { defineEndpoint, ok } from '../src/index.js';
import { createHttpApp } from './fixtures/http.js';

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
      .attach('screenshots', Buffer.from('image-bytes'), 'screen.png');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      body: {
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
});
