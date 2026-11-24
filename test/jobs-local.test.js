import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCricketJobs,
  createJobLedgerTable,
  createLocalQueueDriver,
  cronSchedule,
  defineCricketApp,
  defineJob,
  localQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { createAppMap, formatAppMap } from '../src/app-contract.js';
import { createManualClock, deferred } from '../test-support/jobs.js';

let start = '2026-06-18T12:00:00.000Z';

function appFor(...jobs) {
  return defineCricketApp({
    domains: [{ name: 'localJobs', jobs }],
    logger() {}
  });
}

test('a local queue rejects competing drivers at startup', async () => {
  let expected = /queues\.local cannot be combined/;
  for (let other of [{ driver: {} }, { redis: { url: 'redis://127.0.0.1' } }, { test: true }]) {
    let queues = { local: true, ...other };
    await assert.rejects(createCricketJobs({ queues }), expected);
    await assert.rejects(startCricketWorker(appFor(), { queues }), expected);
  }
});

test('inspection displays the queue contract and coalescing policy', () => {
  let job = defineJob({
    name: 'inbox.refresh',
    input: z.object({}),
    queue: localQueue({ name: 'inboxes', coalesceKey: 'wake' }),
    run() {}
  });
  let appMap = createAppMap(appFor(job));
  assert.equal(appMap.jobs[0].queueType, 'local');
  assert.equal(appMap.jobs[0].coalescing, true);
  assert.match(formatAppMap(appMap), /queue: inboxes\n +queue contract: local\n +pending jobs: coalesced by key/);
});

test('a shared local queue runs the newest pending wakeup and cancels by job and key', async t => {
  let time = createManualClock(start);
  let driver = createLocalQueueDriver({ now: time.now });
  let job = defineJob({
    name: 'inbox.refresh',
    input: z.object({ inbox: z.string(), version: z.number() }),
    queue: localQueue({ name: 'inboxes', coalesceKey: ({ input }) => input.inbox }),
    run: ({ input }) => input
  });
  let worker = await startCricketWorker(appFor(job), { queues: { driver }, clock: time.clock });
  t.after(() => worker.cleanup());
  let { jobs } = await createCricketJobs({ queues: { driver }, clock: time.clock });

  await jobs.enqueue(job, { inbox: 'a', version: 1 }, { delayMs: 100 });
  await jobs.enqueue(job, { inbox: 'a', version: 2 }, { delayMs: 200 });
  await jobs.enqueue(job, { inbox: 'b', version: 1 }, { delayMs: 100 });
  assert.deepEqual(await jobs.cancelPending(job, 'b'), { cancelled: true });
  assert.deepEqual(await jobs.cancelPending(job, 'b'), { cancelled: false });
  time.advanceBy(100);
  assert.deepEqual(await worker.drain(), []);
  time.advanceBy(100);
  assert.deepEqual(await worker.drain(), [{ inbox: 'a', version: 2 }]);
});

test('a pending replacement waits for its active run while independent work continues', { timeout: 5000 }, async t => {
  let firstStarted = deferred();
  let release = deferred();
  let nextStarted = deferred();
  let independentRan = deferred();
  let ran = [];
  let job = defineJob({
    name: 'inbox.wake',
    input: z.object({ version: z.number() }),
    queue: localQueue({ name: 'maintenance', coalesceKey: 'wake' }),
    async run({ input: { version } }) {
      ran.push(version);
      if (version === 1) {
        firstStarted.resolve();
        await release.promise;
      } else {
        nextStarted.resolve();
      }
    }
  });
  let independent = defineJob({
    name: 'desktop.notify',
    input: z.object({}),
    queue: localQueue({ name: 'maintenance' }),
    run() {
      independentRan.resolve();
    }
  });
  let worker = await startCricketWorker(appFor(job, independent), { queues: { local: true } });
  t.after(async () => {
    release.resolve();
    await worker.cleanup();
  });
  await worker.jobs.enqueue(job, { version: 1 });
  let running = worker.run({ concurrency: 2 });
  await firstStarted.promise;
  assert.deepEqual(await worker.jobs.cancelPending(job, 'wake'), { cancelled: false });
  await worker.jobs.enqueue(job, { version: 2 });
  await worker.jobs.enqueue(job, { version: 3 });
  await worker.jobs.enqueue(independent, {});
  await independentRan.promise;
  assert.deepEqual(ran, [1]);
  release.resolve();
  await nextStarted.promise;
  await worker.cleanup();
  await running;
  assert.deepEqual(ran, [1, 3]);
});

test('the local driver wakes a running worker on the requested deadline and stops when aborted', { timeout: 5000 }, async t => {
  let time = createManualClock(start);
  let ran = deferred();
  let job = defineJob({
    name: 'inbox.delayed',
    input: z.object({}),
    queue: localQueue({ name: 'inboxes' }),
    run: () => ran.resolve()
  });
  let worker = await startCricketWorker(appFor(job), { queues: { local: true }, clock: time.clock });
  t.after(() => worker.cleanup());
  let shutdown = new AbortController();
  let until = time.nextWait();
  await worker.jobs.enqueue(job, {}, { delayMs: 500 });
  let running = worker.run({ signal: shutdown.signal });
  assert.equal((await until).toISOString(), '2026-06-18T12:00:00.500Z');
  time.advanceBy(500);
  await ran.promise;
  shutdown.abort();
  await running;
});

test('ordinary local jobs respect idempotency, priority, and retry deadlines', async t => {
  let time = createManualClock(start);
  let attempts = [];
  let job = defineJob({
    name: 'inbox.compute',
    input: z.object({ key: z.string(), priority: z.number() }),
    queue: localQueue({
      name: 'maintenance',
      idempotencyKey: ({ input }) => input.key,
      priority: ({ input }) => input.priority
    }),
    retry: retry.exponential({ attempts: 2, delayMs: 20 }),
    run({ input, attempt }) {
      attempts.push([input.key, attempt]);
      if (input.key === 'high' && attempt === 1)
        throw new Error('temporary');
      return input.key;
    }
  });
  let worker = await startCricketWorker(appFor(job), { queues: { local: true }, clock: time.clock });
  t.after(() => worker.cleanup());
  await worker.jobs.enqueue(job, { key: 'low', priority: 1 });
  await worker.jobs.enqueue(job, { key: 'high', priority: 2 });
  assert.equal((await worker.jobs.enqueue(job, { key: 'high', priority: 3 })).duplicate, true);
  await worker.drain();
  assert.deepEqual(attempts, [['high', 1], ['low', 1]]);
  time.advanceBy(19);
  assert.deepEqual(await worker.drain(), []);
  time.advanceBy(1);
  assert.deepEqual(await worker.drain(), ['high']);
  assert.deepEqual(attempts, [['high', 1], ['low', 1], ['high', 2]]);
});

test('local cron jobs remember the slot within the process', async t => {
  let time = createManualClock('2026-06-18T12:00:10.000Z');
  let job = defineJob({
    name: 'inbox.sweep',
    input: z.object({}),
    queue: localQueue({ name: 'maintenance' }),
    schedule: cronSchedule({ key: 'sweep', cron: '* * * * *', input: () => ({}) }),
    run: ({ envelope }) => envelope.scheduledFor
  });
  let worker = await startCricketWorker(appFor(job), { queues: { local: true }, clock: time.clock });
  t.after(() => worker.cleanup());
  time.advanceTo('2026-06-18T12:01:00.000Z');
  await Promise.all([worker.schedules.tick(), worker.schedules.tick()]);
  assert.deepEqual(await worker.drain(), ['2026-06-18T12:01:00.000Z']);
  await worker.schedules.tick();
  assert.deepEqual(await worker.drain(), []);
});

test('the ledger distinguishes replaced wakeups from cancelled wakeups', async t => {
  let job = defineJob({
    name: 'inbox.ledgerWake',
    input: z.object({}),
    queue: localQueue({ name: 'maintenance', coalesceKey: 'wake' }),
    run: () => 'unexpected'
  });
  let worker = await startCricketWorker(defineCricketApp({
    domains: [{ name: 'localJobs', jobs: [job] }],
    database: { client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true },
    setup: ({ db }) => createJobLedgerTable(db),
    logger() {}
  }), { queues: { local: true } });
  t.after(() => worker.cleanup());
  let first = await worker.jobs.enqueue(job, {});
  let second = await worker.jobs.enqueue(job, {});
  await worker.jobs.cancelPending(job, 'wake');
  assert.deepEqual(await worker.drain(), []);
  let rows = await worker.runtime.dependencies.db('cricket_jobs').select('id', 'status');
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.status])), {
    [first.envelope.id]: 'superseded',
    [second.envelope.id]: 'cancelled'
  });
});
