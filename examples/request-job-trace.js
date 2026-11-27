import {
  createCricketJobs,
  createCricketLogger,
  createLocalQueueDriver,
  defineCricketApp,
  defineEndpoint,
  defineJob,
  localQueue,
  respond,
  startCricketApp,
  startCricketWorker,
  z
} from '@robdel12/cricket';

let publishReport = defineJob({
  name: 'reports.publish',
  input: z.object({ reportId: z.string() }),
  queue: localQueue({ name: 'reports' }),
  run: ({ input }) => ({ published: input.reportId })
});

let renderReport = defineJob({
  name: 'reports.render',
  input: z.object({ reportId: z.string() }),
  queue: localQueue({ name: 'reports' }),
  async run({ input, trace, jobs, jobRunId, requestId }) {
    let report = await trace.span('reports.renderDocument', () => ({ reportId: input.reportId }));
    await jobs.enqueue(publishReport, report, { parentJobRunId: jobRunId, requestId });
    return report;
  }
});

let logger = createCricketLogger();
let driver = createLocalQueueDriver();
let producer = await createCricketJobs({ queues: { driver }, logger });

let requestReport = defineEndpoint({
  method: 'POST',
  path: '/reports',
  body: z.object({ reportId: z.string() }),
  async handler({ input, request, trace }) {
    let { envelope } = await trace.span('reports.enqueue', () =>
      producer.jobs.enqueue(renderReport, input.body, { requestId: request.id })
    );
    return respond(202, { jobId: envelope.id });
  }
});

let app = defineCricketApp({
  domains: [{ name: 'reports', endpoints: [requestReport], jobs: [renderReport, publishReport] }],
  logger
});
let worker = await startCricketWorker(app, { queues: { driver } });

try {
  let server = await startCricketApp(app, { host: '127.0.0.1', port: 0 });
  try {
    let response = await fetch(new URL('/reports', server.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportId: 'r1' })
    });
    if (response.status !== 202)
      throw new Error(`Report enqueue failed with status ${response.status}`);
    await response.json();
    await worker.drain();
  } finally {
    await server.stop();
  }
} finally {
  await worker.cleanup();
}
