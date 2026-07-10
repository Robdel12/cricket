import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  created,
  defineCricketApp,
  defineEndpoint,
  ok,
  redirect,
  respond,
  withCookies,
  withHeaders,
  z
} from '../src/index.js';
import {
  discoverTestFiles,
  runTestCommand
} from '../src/test/cli.js';
import {
  createTestRuntime as createPackagedTestRuntime
} from '@robdel12/cricket/test';
import {
  createTestRuntime,
  createTestState
} from '../src/test/index.js';

function collectOutput() {
  let text = '';

  return {
    stream: new Writable({
      write(chunk, encoding, callback) {
        text += chunk.toString('utf8');
        callback();
      }
    }),
    text() {
      return text;
    }
  };
}

async function createTempTestProject(prefix, testName) {
  let root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  await fs.mkdir(path.join(root, 'test'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module'
    })
  );
  await fs.writeFile(path.join(root, 'test', 'health.test.js'), [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    '',
    `test("${testName}", () => {`,
    '  assert.equal(200, 200);',
    '});',
    ''
  ].join('\n'));

  return root;
}

describe('Cricket test harness', () => {
  it('tests API behavior through HTTP and exposes request trace data', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/projects/:projectId',
      operationId: 'createProject',
      params: z.object({
        projectId: z.string()
      }),
      body: z.object({
        name: z.string()
      }),
      response: z.object({
        id: z.string(),
        name: z.string()
      }),
      async handler({ input, trace }) {
        return await trace.span('project.persist', {
          table: 'projects'
        }, () => created({
          id: input.params.projectId,
          name: input.body.name
        }));
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup, testState } = await createTestRuntime(app);

    try {
      let response = await api.post('/projects/proj_123', {
        query: {
          source: 'api'
        },
        headers: {
          authorization: 'Bearer secret-token'
        },
        body: {
          name: 'Launch Plan'
        }
      });

      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        id: 'proj_123',
        name: 'Launch Plan'
      });
      assert.match(response.requestId, /^test_/);

      let request = testState.request(response.requestId);
      assert.equal(request.response.status, 201);
      assert.deepEqual(request.route, {
        method: 'POST',
        path: '/projects/:projectId',
        operationId: 'createProject'
      });
      assert.equal(request.request.headers.includes('authorization'), true);
      assert.equal(request.request.query.includes('source'), true);
      assert.equal(request.request.hasBody, true);
      assert.equal(Number.isFinite(request.timings.totalMs), true);
      assert.equal(Number.isFinite(request.timings.routeMatchMs), true);
      assert.equal(Number.isFinite(request.timings.validationMs), true);
      assert.equal(Number.isFinite(request.timings.handlerMs), true);
      assert.equal(Number.isFinite(request.timings.responseMs), true);
      assert.equal(Number.isFinite(request.timings.finishMs), true);

      let trace = testState.trace(response.requestId);

      assert.equal(trace.events.map(event => event.type).includes('request.started'), true);
      assert.equal(trace.spans.some(span => span.name === 'createProject'), true);
      assert.equal(trace.spans.some(span => span.name === 'project.persist'), true);
      assert.equal(trace.logs.some(log => log.event === 'http.response.finished'), true);
      assert.equal(trace.logs.every(log => log.metadata.authorization !== 'Bearer secret-token'), true);

      let serialized = JSON.stringify(testState.report());

      assert.equal(serialized.includes('secret-token'), false);
      assert.equal(serialized.includes('Launch Plan'), false);
    } finally {
      await cleanup();
    }
  });

  it('keeps app observability while adding test inspection', async () => {
    let observed = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          healthy: true
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint],
      observability(event) {
        observed.push(event);
      }
    });
    let { api, cleanup, testState } = await createTestRuntime(app);

    try {
      let response = await api.get('/health');

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        healthy: true
      });
      assert.deepEqual(
        observed.map(event => event.type),
        testState.events().map(event => event.type)
      );
    } finally {
      await cleanup();
    }
  });

  it('keeps app logging while adding test log inspection', async () => {
    let appLogs = [];
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler({ logger }) {
        logger.info('health.checked', {
          healthy: true
        });

        return ok({
          healthy: true
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint],
      logger(event, metadata) {
        appLogs.push({
          event,
          metadata
        });
      }
    });
    let { api, cleanup, testState } = await createTestRuntime(app);

    try {
      let response = await api.get('/health');

      assert.equal(response.status, 200);
      assert.equal(appLogs.some(log => log.event === 'health.checked'), true);
      assert.equal(testState.logs().some(log => log.event === 'health.checked'), true);
    } finally {
      await cleanup();
    }
  });

  it('exports the public test runtime helper through the package subpath', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          healthy: true
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createPackagedTestRuntime(app);

    try {
      let response = await api.get('/health');

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        healthy: true
      });
    } finally {
      await cleanup();
    }
  });

  it('parses structured JSON response media types', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/problem',
      handler() {
        return withHeaders(
          respond(400, { title: 'Bad request' }),
          {
            'content-type': 'application/problem+json'
          }
        );
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let response = await api.get('/problem');

      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        title: 'Bad request'
      });
    } finally {
      await cleanup();
    }
  });

  it('preserves binary response bodies in HTTP tests', async () => {
    let image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/image.png',
      handler() {
        return withHeaders(
          ok(image),
          {
            'content-type': 'image/png'
          }
        );
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let response = await api.get('/image.png');

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, image);
      assert.equal(response.text, image.toString('utf8'));
    } finally {
      await cleanup();
    }
  });

  it('keeps redirects inspectable by default', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/legacy',
      handler() {
        return redirect('/current', 302);
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let response = await api.get('/legacy');

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, '/current');
    } finally {
      await cleanup();
    }
  });

  it('rejects body options for GET and HEAD test requests', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          healthy: true
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      await assert.rejects(
        () => api.get('/health', {
          body: {
            hidden: true
          }
        }),
        /GET requests cannot include a body/
      );
      await assert.rejects(
        () => api.head('/health', {
          text: 'hidden'
        }),
        /HEAD requests cannot include a body/
      );
    } finally {
      await cleanup();
    }
  });

  it('preserves multiple Set-Cookie headers in HTTP tests', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/session',
      handler() {
        return withCookies(
          ok({ ok: true }),
          [
            {
              name: 'accessToken',
              value: 'access-token',
              options: {
                httpOnly: true
              }
            },
            {
              name: 'refreshToken',
              value: 'refresh-token',
              options: {
                httpOnly: true
              }
            }
          ]
        );
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let response = await api.post('/session');

      assert.equal(response.status, 200);
      assert.equal(Array.isArray(response.headers['set-cookie']), true);
      assert.equal(response.headers['set-cookie'].some(cookie => cookie.startsWith('accessToken=')), true);
      assert.equal(response.headers['set-cookie'].some(cookie => cookie.startsWith('refreshToken=')), true);
    } finally {
      await cleanup();
    }
  });

  it('keeps test transport isolated from app fetch mocks', async (t) => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return ok({
          healthy: true
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => ({
          mocked: true
        })
      }));

      let response = await api.get('/health');

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        healthy: true
      });
    } finally {
      await cleanup();
    }
  });

  it('sends multipart form data through the HTTP test client', async () => {
    let endpoint = defineEndpoint({
      method: 'post',
      path: '/uploads',
      rawBody: {
        maxBytes: 1024 * 1024
      },
      handler({ request }) {
        return created({
          contentType: request.headers['content-type'],
          bytes: request.rawBody.length
        });
      }
    });
    let app = defineCricketApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let formData = new FormData();

      formData.append('title', 'Wall cloud');
      formData.append('image', new Blob(['image-bytes'], {
        type: 'image/png'
      }), 'wall-cloud.png');

      let response = await api.post('/uploads', {
        formData
      });

      assert.equal(response.status, 201);
      assert.match(response.body.contentType, /^multipart\/form-data; boundary=/);
      assert.equal(response.body.bytes > 0, true);
    } finally {
      await cleanup();
    }
  });

  it('supports focused state collection without a runtime', () => {
    let testState = createTestState();

    testState.recordEvent({
      type: 'response.finished',
      requestId: 'req_1',
      request: {
        method: 'GET',
        path: '/health'
      },
      response: {
        status: 200
      },
      timings: {
        totalMs: 4.2,
        handlerMs: 1.1
      }
    });

    assert.deepEqual(testState.requests({
      requestId: 'req_1'
    }), [
      {
        requestId: 'req_1',
        route: undefined,
        request: {
          method: 'GET',
          path: '/health'
        },
        response: {
          status: 200
        },
        timings: {
          totalMs: 4.2,
          handlerMs: 1.1
        },
        replay: []
      }
    ]);
    assert.equal(testState.request('req_1').timings.handlerMs, 1.1);

    testState.clear();

    assert.deepEqual(testState.requests(), []);
  });

  it('discovers app and test folder files by convention', async () => {
    let root = await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-discovery-'));

    await fs.mkdir(path.join(root, 'api', 'domains', 'projects'), {
      recursive: true
    });
    await fs.mkdir(path.join(root, 'test'), {
      recursive: true
    });
    await fs.writeFile(
      path.join(root, 'api', 'domains', 'projects', 'projects.test.js'),
      ''
    );
    await fs.writeFile(
      path.join(root, 'test', 'fallback.test.js'),
      ''
    );

    assert.deepEqual(await discoverTestFiles(root), [
      'api/domains/projects/projects.test.js',
      'test/fallback.test.js'
    ]);
  });

  it('runs node tests and emits Cricket JSON from the CLI boundary', async () => {
    let root = await createTempTestProject('cricket-cli-', 'health endpoint behavior');
    let stdout = collectOutput();
    let stderr = collectOutput();
    let previousExitCode = process.exitCode;

    try {
      let report = await runTestCommand(['--json', '--concurrency', '1'], {
        cwd: root,
        stdout: stdout.stream,
        stderr: stderr.stream
      });
      let printed = JSON.parse(stdout.text());

      assert.equal(stderr.text(), '');
      assert.equal(report.counts.failed, 0);
      assert.equal(report.counts.tests, 1);
      let [testResult] = report.tests;

      assert.equal(testResult.name, 'health endpoint behavior');
      assert.equal(testResult.status, 'passed');
      assert.equal(Number.isFinite(testResult.durationMs), true);
      assert.deepEqual(printed.counts, report.counts);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('returns a report when the CLI prints human output', async () => {
    let root = await createTempTestProject('cricket-cli-human-', 'human report behavior');
    let stdout = collectOutput();
    let stderr = collectOutput();
    let previousExitCode = process.exitCode;

    try {
      let report = await runTestCommand([], {
        cwd: root,
        stdout: stdout.stream,
        stderr: stderr.stream
      });

      assert.equal(stderr.text(), '');
      assert.equal(stdout.text().includes('human report behavior'), true);
      assert.equal(report.counts.tests, 1);
      assert.equal(report.tests[0].name, 'human report behavior');
      assert.equal(report.tests[0].status, 'passed');
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
