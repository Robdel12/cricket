import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concurrency,
  createCricketJobs,
  cronSchedule,
  defineCricketApp,
  defineCricketPlugin,
  defineJob,
  jobFailure,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';
import { createTestQueueDriver } from '../src/jobs/test-driver.js';
import { createTestState } from '../src/test/index.js';
import { app as pluginCompositionApp } from '../examples/plugin-composition/app.js';
import {
  createManualClock,
  createTestApp,
  deferred,
  reportJob
} from '../test-support/jobs.js';

describe('Cricket jobs: worker', () => {
  it('runs accepted jobs up to the local limit and joins them after abort', async () => {
    let started = new Map(['first', 'second'].map(id => [id, deferred()]));
    let release = new Map(['first', 'second'].map(id => [id, deferred()]));
    let completed = [];
    let controller = new AbortController();
    let job = defineJob({
      name: 'reports.concurrent',
      input: z.object({ id: z.string() }),
      queue: redisQueue({
        name: 'concurrent',
        priority: ({ input }) => ({
          first: 3,
          second: 2,
          queued: 1
        })[input.id]
      }),
      async run({ input }) {
        started.get(input.id)?.resolve();
        await release.get(input.id)?.promise;
        completed.push(input.id);
        return { id: input.id };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { test: true }
    });
    let runFinished = false;

    try {
      let enqueued = await Promise.all(['first', 'second', 'queued'].map(id =>
        worker.jobs.enqueue(job, { id })
      ));
      let running = worker.run({ signal: controller.signal, concurrency: 2 })
        .then(() => { runFinished = true; });
      await Promise.all([...started.values()].map(item => item.promise));
      controller.abort();
      await Promise.resolve();
      assert.equal(runFinished, false, 'run joins both accepted jobs after abort');
      assert.deepEqual(worker.driver.snapshot().items.map(item => item.status), [
        'active', 'active', 'queued'
      ]);

      release.get('first').resolve();
      release.get('second').resolve();
      await running;

      assert.deepEqual(completed.sort(), ['first', 'second']);
      assert.deepEqual(worker.driver.snapshot().items.map(item => item.status), [
        'completed', 'completed', 'queued'
      ]);
      assert.equal(enqueued.length, 3);
    } finally {
      controller.abort();
      for (let gate of release.values()) gate.resolve();
      await worker.cleanup();
    }
  });

  it('keeps run concurrency within each job partition', async () => {
    let started = new Map(['a-first', 'a-second', 'b-first'].map(id => [id, deferred()]));
    let release = new Map(['a-first', 'a-second', 'b-first'].map(id => [id, deferred()]));
    let finished = new Map(['a-first', 'a-second', 'b-first'].map(id => [id, deferred()]));
    let activeByOrganization = new Map();
    let maxActiveByOrganization = new Map();
    let job = defineJob({
      name: 'reports.partitionedConcurrency',
      input: z.object({ id: z.string(), organization: z.string() }),
      queue: redisQueue({ name: 'partitioned-concurrency' }),
      concurrency: concurrency.partition({
        key: ({ input }) => `organization:${input.organization}`,
        limit: 1
      }),
      async run({ input }) {
        let active = (activeByOrganization.get(input.organization) ?? 0) + 1;
        activeByOrganization.set(input.organization, active);
        maxActiveByOrganization.set(input.organization, Math.max(
          maxActiveByOrganization.get(input.organization) ?? 0,
          active
        ));
        started.get(input.id)?.resolve();
        await release.get(input.id)?.promise;
        activeByOrganization.set(input.organization, active - 1);
        finished.get(input.id)?.resolve();
        return { id: input.id };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { test: true }
    });
    let controller = new AbortController();

    try {
      await worker.jobs.enqueue(job, { id: 'a-first', organization: 'a' });
      await worker.jobs.enqueue(job, { id: 'a-second', organization: 'a' });
      await worker.jobs.enqueue(job, { id: 'b-first', organization: 'b' });
      let running = worker.run({ signal: controller.signal, concurrency: 3 });
      await Promise.all([started.get('a-first').promise, started.get('b-first').promise]);
      assert.equal(activeByOrganization.get('a'), 1);
      assert.equal(activeByOrganization.get('b'), 1);

      release.get('b-first').resolve();
      await finished.get('b-first').promise;
      assert.equal(activeByOrganization.get('a'), 1);

      release.get('a-first').resolve();
      await finished.get('a-first').promise;
      await started.get('a-second').promise;
      assert.deepEqual([...maxActiveByOrganization.values()], [1, 1]);
      release.get('a-second').resolve();
      await finished.get('a-second').promise;
      controller.abort();
      await running;
      assert.equal(activeByOrganization.get('a'), 0);
    } finally {
      controller.abort();
      for (let gate of release.values()) gate.resolve();
      await worker.cleanup();
    }
  });

  it('executes a claim that resolves after the run signal aborts', async () => {
    let claimEntered = deferred();
    let releaseClaim = deferred();
    let jobStarted = deferred();
    let processed = [];
    let job = defineJob({
      name: 'reports.claimRacingAbort',
      input: z.object({ id: z.string() }),
      queue: redisQueue({ name: 'claim-race' }),
      run({ input }) {
        jobStarted.resolve();
        processed.push(input.id);
        return { id: input.id };
      }
    });
    let baseDriver = createTestQueueDriver();
    let driver = {
      ...baseDriver,
      async claim() {
        claimEntered.resolve();
        await releaseClaim.promise;
        return await baseDriver.claim();
      }
    };
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });
    let controller = new AbortController();

    try {
      await worker.jobs.enqueue(job, { id: 'accepted' });
      let running = worker.run({ signal: controller.signal });
      await claimEntered.promise;
      controller.abort();
      releaseClaim.resolve();
      await jobStarted.promise;
      await running;
      assert.deepEqual(processed, ['accepted']);
      assert.equal(worker.driver.snapshot().items[0].status, 'completed');
    } finally {
      controller.abort();
      releaseClaim.resolve();
      await worker.cleanup();
    }
  });

  it('keeps making progress after repeated unclaimable wakeups', async () => {
    let baseDriver = createTestQueueDriver();
    let baseWaitForWork = baseDriver.waitForWork.bind(baseDriver);
    let spuriousWakesRemaining = 25;
    let spuriousWakesDrained = deferred();
    let jobFinished = deferred();
    let processed = [];
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        if (spuriousWakesRemaining) {
          spuriousWakesRemaining -= 1;
          if (!spuriousWakesRemaining)
            spuriousWakesDrained.resolve();
          return { reason: 'work' };
        }

        return await baseWaitForWork(options);
      }
    };
    let job = defineJob({
      name: 'reports.spuriousWakeups',
      input: z.object({ id: z.string() }),
      queue: redisQueue({ name: 'spurious-wakeups' }),
      run({ input }) {
        processed.push(input.id);
        jobFinished.resolve();
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      jobs: [job],
      queues: { driver }
    });
    let controller = new AbortController();

    try {
      let running = worker.run({ signal: controller.signal });
      await spuriousWakesDrained.promise;
      await worker.jobs.enqueue(job, { id: 'after-wakes' });
      await jobFinished.promise;
      controller.abort();
      await running;

      assert.deepEqual(processed, ['after-wakes']);
      assert.equal(spuriousWakesRemaining, 0);
    } finally {
      controller.abort();
      await worker.cleanup();
    }
  });

  it('recovers an expired foreign claim while local work remains active', async () => {
    let clock = createManualClock('2026-06-19T12:00:00.000Z');
    let localStarted = deferred();
    let releaseLocal = deferred();
    let foreignRecovered = deferred();
    let foreignStarted = deferred();
    let controller = new AbortController();
    let foreign = defineJob({
      name: 'reports.foreignRecovery',
      input: z.object({}),
      queue: redisQueue({ name: 'foreign-recovery', priority: () => 1 }),
      recover() {
        foreignRecovered.resolve();
        return { action: 'retry', reason: 'Expired on another worker' };
      },
      run() {
        foreignStarted.resolve();
      }
    });
    let local = defineJob({
      name: 'reports.localLongWork',
      input: z.object({}),
      queue: redisQueue({ name: 'local-long-work', priority: () => 2 }),
      async run() {
        localStarted.resolve();
        await releaseLocal.promise;
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      clock: clock.clock,
      jobs: [foreign, local],
      queues: { test: true }
    });

    try {
      await worker.jobs.enqueue(foreign, {});
      await worker.driver.claim();
      await worker.jobs.enqueue(local, {});
      clock.advanceBy(60_000);
      let running = worker.run({ signal: controller.signal, concurrency: 1 });

      await Promise.all([foreignRecovered.promise, localStarted.promise]);
      assert.equal(worker.driver.snapshot().items.find(item =>
        item.envelope.name === foreign.name
      ).status, 'queued');

      releaseLocal.resolve();
      await foreignStarted.promise;
      controller.abort();
      await running;
    } finally {
      controller.abort();
      releaseLocal.resolve();
      await worker.cleanup();
    }
  });

  it('bounds run concurrency and allows only one active run loop', async () => {
    let waiting = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      queues: { driver }
    });
    let controller = new AbortController();

    try {
      await assert.rejects(worker.run({ concurrency: 0 }), /concurrency must be an integer/);
      await assert.rejects(worker.run({ concurrency: 1.5 }), /concurrency must be an integer/);
      await assert.rejects(worker.run({ concurrency: 101 }), /concurrency must be an integer/);
      await assert.rejects(worker.run({ concurrency: Number.MAX_SAFE_INTEGER + 1 }),
        /concurrency must be an integer/
      );
      let running = worker.run({ signal: controller.signal, concurrency: 2 });
      await waiting.promise;
      await assert.rejects(worker.run(), /worker\.run is already active/);
      controller.abort();
      await running;
    } finally {
      controller.abort();
      await worker.cleanup();
    }
  });

  it('joins accepted work before rejecting when throwOnError is enabled', async () => {
    let started = new Map(['failure', 'held'].map(id => [id, deferred()]));
    let releaseHeld = deferred();
    let failureLogged = deferred();
    let failure = new Error('first job failed');
    let job = defineJob({
      name: 'reports.concurrentFailure',
      input: z.object({ id: z.string() }),
      queue: redisQueue({
        name: 'concurrent-failure',
        priority: ({ input }) => input.id === 'failure' ? 2 : 1
      }),
      failure: jobFailure({
        exhausted() {
          failureLogged.resolve();
        }
      }),
      async run({ input }) {
        started.get(input.id).resolve();
        if (input.id === 'failure')
          throw failure;
        await releaseHeld.promise;
        return { id: input.id };
      }
    });
    let app = defineManualTestApp({
      logger() {
        return {
          child() { return this; },
          info() {},
          warn() {},
          error(event) {
            if (event === 'job.failed')
              failureLogged.resolve();
          }
        };
      }
    });
    let worker = await startCricketWorker(app, {
      jobs: [job],
      queues: { test: true }
    });
    let runSettled = false;

    try {
      await worker.jobs.enqueue(job, { id: 'failure' });
      await worker.jobs.enqueue(job, { id: 'held' });
      let running = worker.run({ concurrency: 2, throwOnError: true })
        .finally(() => { runSettled = true; });
      await Promise.all([...started.values()].map(item => item.promise));
      await failureLogged.promise;
      assert.equal(runSettled, false, 'run waits for all accepted work before rejecting');

      releaseHeld.resolve();
      await assert.rejects(running, error => error === failure);
      assert.deepEqual(worker.driver.snapshot().items.map(item => item.status), [
        'failed', 'completed'
      ]);
    } finally {
      releaseHeld.resolve();
      await worker.cleanup();
    }
  });

  it('services recovery, due delayed work, and cron jobs before a ready backlog drains', async () => {
    let time = createManualClock('2026-06-19T12:00:01.000Z');
    let controller = new AbortController();
    let ran = [];
    let backlog = defineJob({
      name: 'reports.backlog',
      input: z.object({ index: z.number() }),
      queue: redisQueue({ name: 'backlog', priority: ({ input }) => 5 - input.index }),
      run({ input }) {
        ran.push(`backlog:${input.index}`);
        if (input.index === 0) time.advanceBy(60_000);
      }
    });
    let interrupted = defineJob({
      name: 'reports.interrupted',
      input: z.object({}),
      queue: redisQueue({ name: 'interrupted', priority: () => 30 }),
      recover({ now }) {
        return new Date(now) >= new Date('2026-06-19T12:01:00.000Z')
          ? { action: 'retry', reason: 'Processing deadline passed' }
          : { action: 'continue' };
      },
      run() { ran.push('recovered'); }
    });
    let delayed = defineJob({
      name: 'reports.delayed',
      input: z.object({}),
      queue: redisQueue({ name: 'delayed', priority: () => 20 }),
      run() { ran.push('delayed'); }
    });
    let scheduled = defineJob({
      name: 'maintenance.backlogSchedule',
      input: z.object({}),
      queue: redisQueue({ name: 'scheduled', priority: () => 10 }),
      schedule: cronSchedule({ key: 'busy_schedule', cron: '* * * * *', input: () => ({}) }),
      run() {
        ran.push('scheduled');
        controller.abort();
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger() {} }), {
      clock: time.clock,
      jobs: [backlog, interrupted, delayed, scheduled],
      queues: { test: true }
    });
    try {
      await worker.jobs.enqueue(interrupted, {});
      await worker.driver.claim();
      await worker.jobs.enqueue(delayed, {}, { delayMs: 60_000 });
      for (let index = 0; index < 5; index++) await worker.jobs.enqueue(backlog, { index });
      await worker.run({ signal: controller.signal });
      assert.deepEqual(ran, ['backlog:0', 'recovered', 'delayed', 'scheduled']);
    } finally {
      await worker.cleanup();
    }
  });

  it('discovers filesystem and plugin jobs in one worker with their service contexts', async () => {
    let worker = await startCricketWorker(pluginCompositionApp, {
      baseUrl: new URL('../examples/plugin-composition/app.js', import.meta.url),
      queues: {
        test: true
      }
    });

    try {
      let projectJob = worker.runtime.contract.jobs.find(job => job.name === 'projects.reindex');
      let adminJob = worker.runtime.contract.jobs.find(job => job.name === 'admin.support.record-action');

      assert.deepEqual(worker.runtime.contract.jobs.map(job => job.name), [
        'projects.reindex',
        'admin.support.record-action'
      ]);
      assert.ok(projectJob);
      assert.ok(adminJob);

      await worker.jobs.enqueue(projectJob, { projectId: 'project-1' });
      await worker.jobs.enqueue(adminJob, { userId: 'user-7', action: 'suspend' });

      assert.deepEqual(new Set(await worker.drain()), new Set([
        { indexed: true },
        { recorded: true }
      ]));
    } finally {
      await worker.cleanup();
    }
  });

  it('discovers and runs jobs contributed by plugin domains with app services', async () => {
    let processed = [];
    let job = defineJob({
      name: 'admin.support.user-action',
      input: z.object({
        userId: z.string(),
        action: z.enum(['suspend', 'restore'])
      }),
      result: z.object({ recorded: z.boolean() }),
      queue: redisQueue({ name: 'admin-support' }),
      async run({ input, services }) {
        await services.support.recordUserAction(input);
        return { recorded: true };
      }
    });
    let plugin = defineCricketPlugin({
      name: 'super-admin',
      domains: [{
        name: 'support',
        jobs: [job],
        services: {
          support() {
            return {
              async recordUserAction(input) {
                processed.push(input);
              }
            };
          }
        }
      }]
    });
    let app = defineCricketApp({
      domains: [],
      plugins: [plugin]
    });
    let worker = await startCricketWorker(app, {
      queues: {
        test: true
      }
    });

    try {
      let queued = await worker.jobs.enqueue(job, {
        userId: 'user-7',
        action: 'suspend'
      });
      let results = await worker.drain();

      assert.equal(queued.enqueued, true);
      assert.deepEqual(results, [{ recorded: true }]);
      assert.deepEqual(processed, [{ userId: 'user-7', action: 'suspend' }]);
      assert.deepEqual(worker.runtime.contract.jobs, [job]);
    } finally {
      await worker.cleanup();
    }
  });

  it('rejects duplicate plugin job names before requesting a queue driver', async () => {
    let duplicateJobs = [
      defineJob({
        name: 'admin.refresh',
        input: z.object({}),
        run() {}
      }),
      defineJob({
        name: 'admin.refresh',
        input: z.object({}),
        run() {}
      })
    ];
    let plugin = defineCricketPlugin({
      name: 'super-admin',
      domains: duplicateJobs.map((job, index) => ({
        name: `admin${index + 1}`,
        jobs: [job]
      }))
    });
    let app = defineCricketApp({
      domains: [],
      plugins: [plugin]
    });
    let driverRequested = false;
    let queues = {
      get driver() {
        driverRequested = true;
        return {};
      }
    };

    await assert.rejects(startCricketWorker(app, {
      queues
    }), /duplicate job name admin\.refresh/);
    assert.equal(driverRequested, false);
  });

  it('requires an explicit queue driver for producers and workers', async () => {
    let job = reportJob();

    await assert.rejects(
      createCricketJobs({
        jobs: [job]
      }),
      /queues\.driver, queues\.redis, or explicit queues\.test/
    );
    await assert.rejects(
      startCricketWorker(defineManualTestApp({}), {
        jobs: [job]
      }),
      /queues\.driver, queues\.redis, or explicit queues\.test/
    );
  });


  it('requires custom worker clocks to own deadline waits', async () => {
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      clock: {
        now: () => new Date('2026-06-18T12:00:00.000Z')
      },
      queues: {
        test: true
      }
    });

    try {
      await assert.rejects(
        worker.run(),
        /custom clock\.now needs clock\.waitUntil/
      );
    } finally {
      await worker.cleanup();
    }
  });


  it('runs jobs through Cricket services, logger, trace, progress, and test state', async () => {
    let processed = [];
    let testState = createTestState();
    let job = reportJob(processed);
    let app = createTestApp(testState, [job]);
    let worker = await startCricketWorker(app, {
      queues: {
        test: true
      }
    });

    try {
      let first = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      }, {
        context: {
          requestId: 'req_job_1',
          source: 'report.requested',
          priority: 10
        }
      });
      let duplicate = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      }, {
        context: {
          requestId: 'req_job_1',
          source: 'report.requested',
          priority: 10
        }
      });

      assert.equal(first.enqueued, true);
      assert.equal(duplicate.duplicate, true);

      let results = await worker.drain();

      assert.deepEqual(results, [
        {
          status: 'completed'
        }
      ]);
      assert.deepEqual(processed, ['report_123']);
      let afterCompletion = await worker.jobs.enqueue(job, {
        reportId: 'report_123',
        accountId: 'acct_456',
        templateId: 'template_789'
      });

      assert.equal(afterCompletion.enqueued, true);
      assert.ok(testState.jobs().some(event => event.type === 'job.completed'));
      assert.ok(testState.jobs().some(event => event.type === 'job.progressed'));
      assert.ok(testState.logs().some(log => log.event === 'report.started'));
      assert.ok(testState.events().some(event => event.type === 'trace.span.finished'));
    } finally {
      await worker.cleanup();
    }
  });

  it('rejects jobs that are not owned by a structured app domain', async () => {
    let job = reportJob();
    let app = defineCricketApp({
      domains: []
    });

    await assert.rejects(startCricketWorker(app, {
      jobs: [job],
      queues: {
        test: true
      }
    }), /cannot run unregistered jobs: reports\.generate/);
  });


  it('wakes the worker loop for enqueued work and stops on abort', async () => {
    let waiting = deferred();
    let completed = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let job = defineJob({
      name: 'reports.eventDriven',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        driver
      }
    });
    let controller = new AbortController();

    try {
      let running = worker.run({
        signal: controller.signal
      });

      await waiting.promise;
      await worker.jobs.enqueue(job, {
        reportId: 'report_event_driven'
      });
      assert.equal(await completed.promise, 'report_event_driven');

      controller.abort();
      await running;

      assert.equal(driver.snapshot().items[0].status, 'completed');
    } finally {
      await worker.cleanup();
    }
  });

  it('stops a blocked worker loop when cleanup begins', async () => {
    let waiting = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      queues: {
        driver
      }
    });
    let cleaned = false;

    try {
      let running = worker.run();

      await waiting.promise;
      await worker.cleanup();
      cleaned = true;
      await running;
    } finally {
      if (!cleaned)
        await worker.cleanup();
    }
  });

  it('recomputes its deadline when delayed work arrives after waiting starts', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let waiting = deferred();
    let completed = deferred();
    let baseDriver = createTestQueueDriver();
    let waitForWork = baseDriver.waitForWork.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async waitForWork(options) {
        waiting.resolve();
        return await waitForWork(options);
      }
    };
    let job = defineJob({
      name: 'reports.lateDelayedBoundary',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        driver
      }
    });
    let controller = new AbortController();

    try {
      let running = worker.run({
        signal: controller.signal
      });

      await waiting.promise;
      let nextWait = time.nextWait();
      await worker.jobs.enqueue(job, {
        reportId: 'report_late_delayed_boundary'
      }, {
        delayMs: 60_000
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T12:01:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, 'report_late_delayed_boundary');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('wakes the worker loop at the next delayed boundary', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let completed = deferred();
    let job = defineJob({
      name: 'reports.delayedBoundary',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      run({ input }) {
        completed.resolve(input.reportId);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });
    let controller = new AbortController();

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_delayed_boundary'
      }, {
        delayMs: 60_000
      });
      let nextWait = time.nextWait();
      let running = worker.run({
        signal: controller.signal
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T12:01:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, 'report_delayed_boundary');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('wakes the worker loop at the next cron boundary', async () => {
    let time = createManualClock('2026-06-19T09:14:00.000Z');
    let completed = deferred();
    let job = defineJob({
      name: 'maintenance.scheduledBoundary',
      input: z.object({
        scheduledFor: z.string()
      }),
      queue: redisQueue({
        name: 'maintenance'
      }),
      schedule: cronSchedule({
        key: 'scheduled_boundary',
        cron: '15 4 * * *',
        timezone: 'America/Chicago',
        input: ({ scheduledFor }) => ({
          scheduledFor
        })
      }),
      run({ input }) {
        completed.resolve(input.scheduledFor);
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        test: true
      }
    });
    let controller = new AbortController();

    try {
      let nextWait = time.nextWait();
      let running = worker.run({
        signal: controller.signal
      });

      assert.equal(
        (await nextWait).toISOString(),
        '2026-06-19T09:15:00.000Z'
      );
      time.advanceBy(60_000);
      assert.equal(await completed.promise, '2026-06-19T09:15:00.000Z');

      controller.abort();
      await running;
    } finally {
      await worker.cleanup();
    }
  });

  it('renews active job heartbeats through the injected clock lifecycle', async () => {
    let time = createManualClock('2026-06-19T12:00:00.000Z');
    let started = deferred();
    let release = deferred();
    let renewed = deferred();
    let heartbeatCount = 0;
    let baseDriver = createTestQueueDriver();
    let heartbeat = baseDriver.heartbeat.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async heartbeat(...args) {
        await heartbeat(...args);
        heartbeatCount += 1;

        if (heartbeatCount === 2)
          renewed.resolve();
      }
    };
    let job = defineJob({
      name: 'reports.longRunning',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async run() {
        started.resolve();
        await release.promise;
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      clock: time.clock,
      jobs: [job],
      queues: {
        driver
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_long_running'
      });
      let nextHeartbeat = time.nextWait();
      let draining = worker.drain();

      await started.promise;
      assert.equal(
        (await nextHeartbeat).toISOString(),
        '2026-06-19T12:00:15.000Z'
      );
      time.advanceBy(15_000);
      await renewed.promise;

      let [candidate] = await driver.recoveryCandidates();
      assert.equal(candidate.lastHeartbeatAt, '2026-06-19T12:00:15.000Z');

      release.resolve();
      assert.deepEqual(await draining, [{
        status: 'completed'
      }]);
    } finally {
      release.resolve();
      await worker.cleanup();
    }
  });

  it('waits for active claims to settle before closing worker resources', async () => {
    let started = deferred();
    let release = deferred();
    let order = [];
    let baseDriver = createTestQueueDriver();
    let complete = baseDriver.complete.bind(baseDriver);
    let cleanup = baseDriver.cleanup.bind(baseDriver);
    let driver = {
      ...baseDriver,
      async complete(...args) {
        let result = await complete(...args);
        order.push('completed');
        return result;
      },
      async cleanup() {
        order.push('cleanup');
        await cleanup();
      }
    };
    let job = defineJob({
      name: 'reports.gracefulCleanup',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async run() {
        started.resolve();
        await release.promise;
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        driver
      }
    });

    await worker.jobs.enqueue(job, {
      reportId: 'report_graceful_cleanup'
    });
    let draining = worker.drain();

    await started.promise;
    let cleaning = worker.cleanup();

    release.resolve();
    await Promise.all([draining, cleaning]);

    assert.deepEqual(order, [
      'completed',
      'cleanup'
    ]);
  });

});
