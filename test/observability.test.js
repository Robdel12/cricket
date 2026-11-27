import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  createCricketJobs,
  createCricketLogger,
  createCricketRuntime,
  createLocalQueueDriver,
  defineCricketApp,
  defineEndpoint,
  defineJob,
  localQueue,
  respond,
  startCricketWorker,
  z
} from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';

test('one trace connects HTTP and the worker while both exporters are blocked', { timeout: 5000 }, async t => {
  let httpExportStarted = Promise.withResolvers();
  let jobExportStarted = Promise.withResolvers();
  let releaseExports = Promise.withResolvers();
  let lines = [];
  let logger = createCricketLogger({ write: line => lines.push(line) });
  let driver = createLocalQueueDriver();
  let producer = await createCricketJobs({ queues: { driver }, logger });
  let http;
  let worker;
  t.after(async () => {
    releaseExports.resolve();
    try {
      await worker?.cleanup();
    } finally {
      await http?.cleanup();
    }
  });

  let job = defineJob({
    name: 'reports.render',
    input: z.object({ name: z.string() }),
    queue: localQueue({ name: 'reports' }),
    run: ({ input, trace }) =>
      trace.span('reports.compose', () => ({ rendered: input.name }))
  });
  let endpoint = defineEndpoint({
    method: 'POST',
    path: '/reports',
    operationId: 'requestReport',
    body: z.object({ name: z.string() }),
    async handler({ input, request, trace }) {
      let { envelope } = await trace.span('reports.enqueue', () =>
        producer.jobs.enqueue(job, input.body, { requestId: request.id })
      );
      return respond(202, { id: envelope.id });
    }
  });

  let app = defineCricketApp({
    logger,
    domains: [{ name: 'reports', endpoints: [endpoint], jobs: [job] }],
    observability: {
      async export(event) {
        if (event.type === 'request.started') httpExportStarted.resolve(event);
        if (event.type === 'job.started') jobExportStarted.resolve(event);
        await releaseExports.promise;
      }
    }
  });

  http = await createTestRuntime(app);
  worker = await startCricketWorker(app, { queues: { driver } });

  let responsePending = http.api.post('/reports', {
    body: { name: 'private input' }
  });
  let requestEvent = await httpExportStarted.promise;
  let response = await responsePending;
  assert.equal(response.status, 202);
  assert.equal(requestEvent.requestId, response.requestId);
  assert.ok(Object.isFrozen(requestEvent));
  assert.equal(requestEvent.replay, undefined);
  assert.ok(!JSON.stringify(requestEvent).includes('private input'));

  let drain = worker.drain();
  let jobEvent = await jobExportStarted.promise;
  assert.deepEqual(await drain, [{ rendered: 'private input' }]);
  assert.equal(jobEvent.requestId, response.requestId);
  assert.equal(jobEvent.envelopeId, response.body.id);
  assert.match(jobEvent.jobRunId, /^jobrun_/);
  assert.ok(!JSON.stringify(jobEvent).includes('private input'));

  let [requestTimeline, jobTimeline] = [response.requestId, jobEvent.jobRunId].map(id => {
    let trace = spawnSync(process.execPath, ['bin/cricket.js', 'trace', id], {
      input: lines.join('\n'),
      encoding: 'utf8'
    });
    assert.equal(trace.status, 0, trace.stderr);
    assert.ok(trace.stdout.startsWith(`Trace ${id}\n`));
    return trace.stdout.slice(trace.stdout.indexOf('\n') + 1);
  });

  assert.equal(jobTimeline, requestTimeline);
  assert.match(requestTimeline, /http\.response\.finished requestReport/);
  assert.match(requestTimeline, /job\.enqueued reports\.render/);
  assert.match(requestTimeline, /job\.started reports\.render jobrun_\S+ attempt=1/);
  assert.match(requestTimeline, /job\.completed reports\.render/);
  assert.ok(requestTimeline.includes(`job=${response.body.id}`));
  assert.match(requestTimeline, /^  .*requestReport .*ms.*\n    .*reports\.enqueue .*ms/m);
  assert.match(requestTimeline, /^  .*job\.run reports\.render .*ms.*\n    .*reports\.compose .*ms/m);

  // Shutdown must finish before the test releases either exporter.
  await worker.cleanup();
  worker = undefined;
  await http.cleanup();
  http = undefined;
});

test('the exporter bounds pending events and keeps sending after a failure', { timeout: 5000 }, async t => {
  let capacity = 256;
  let firstStarted = Promise.withResolvers();
  let releaseFirst = Promise.withResolvers();
  let lastQueued = Promise.withResolvers();
  let resumed = Promise.withResolvers();
  let sent = [];
  let errors = [];
  let runtime = await createCricketRuntime(defineCricketApp({
    domains: [],
    logger: {
      error(event) {
        errors.push(event);
      }
    },
    observability: {
      async export({ sequence }) {
        sent.push(sequence);

        if (sequence === 0) {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw new Error('Destination unavailable');
        }

        if (sequence === capacity) lastQueued.resolve();
        if (sequence === 'resumed') resumed.resolve();
      }
    }
  }));
  t.after(async () => {
    releaseFirst.resolve();
    await runtime.cleanup();
  });

  await runtime.observability.emit({ type: 'test.event', sequence: 0 });
  await firstStarted.promise;
  for (let sequence = 1; sequence <= capacity + 4; sequence++) {
    await runtime.observability.emit({ type: 'test.event', sequence });
  }
  assert.deepEqual(sent, [0]);

  releaseFirst.resolve();
  await lastQueued.promise;
  await runtime.observability.emit({ type: 'test.event', sequence: 'resumed' });
  await resumed.promise;
  assert.deepEqual(sent, [...Array.from({ length: capacity + 1 }, (_, sequence) => sequence), 'resumed']);
  assert.deepEqual(errors, ['observability.export_failed']);
});
