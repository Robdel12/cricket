import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cronSchedule,
  defineCricketApp,
  defineJob,
  planCronSchedule,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { previousCronRun } from '../src/jobs/schedule.js';
import { createTestState } from '../src/test/index.js';
import { createTestApp } from '../test-support/jobs.js';

describe('Cricket jobs: schedules', () => {
  it('plans cron due slots with a fixed clock', () => {
    let schedule = cronSchedule({
      key: 'daily_digest',
      cron: '15 4 * * *',
      timezone: 'America/Chicago',
      input: ({ scheduledFor }) => ({
        runDate: scheduledFor.slice(0, 10)
      })
    });
    let plan = planCronSchedule(schedule, {
      lastRunAt: '2026-06-18T09:15:00.000Z',
      now: new Date('2026-06-19T09:16:00.000Z')
    });

    assert.deepEqual(plan.due, [
      {
        slotId: 'daily_digest:2026-06-19T09:15:00.000Z',
        scheduleKey: 'daily_digest',
        scheduledFor: '2026-06-19T09:15:00.000Z'
      }
    ]);
    assert.equal(plan.nextRunAt, '2026-06-20T09:15:00.000Z');
  });

  it('plans the current cron slot when the clock is exactly on the boundary', () => {
    let schedule = cronSchedule({
      key: 'daily_digest',
      cron: '15 4 * * *',
      timezone: 'America/Chicago',
      input: ({ scheduledFor }) => ({
        runDate: scheduledFor.slice(0, 10)
      })
    });
    let workerStart = new Date('2026-06-19T09:15:00.000Z');
    let plan = planCronSchedule(schedule, {
      lastRunAt: previousCronRun(schedule, workerStart),
      now: workerStart
    });

    assert.deepEqual(plan.due, [
      {
        slotId: 'daily_digest:2026-06-19T09:15:00.000Z',
        scheduleKey: 'daily_digest',
        scheduledFor: '2026-06-19T09:15:00.000Z'
      }
    ]);
  });

  it('materializes and runs cron schedules through the worker boundary', async () => {
    let ran = [];
    let testState = createTestState();
    let now = new Date('2026-06-19T09:14:00.000Z');
    let job = defineJob({
      name: 'maintenance.dailyDigest',
      input: z.object({
        runDate: z.string()
      }),
      queue: redisQueue({
        name: 'maintenance',
        idempotencyKey: ({ input }) => `daily_digest:${input.runDate}`
      }),
      schedule: cronSchedule({
        key: 'daily_digest',
        cron: '15 4 * * *',
        timezone: 'America/Chicago',
        input: ({ scheduledFor }) => ({
          runDate: scheduledFor.slice(0, 10)
        })
      }),
      async run({ input }) {
        ran.push(input);
        return {
          swept: true
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      clock: {
        now: () => now
      },
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.schedules.tick();
      assert.deepEqual(await worker.drain(), []);

      now = new Date('2026-06-19T09:16:00.000Z');
      let materialized = await worker.schedules.tick();

      assert.equal(materialized[0].enqueued, true);
      assert.deepEqual(await worker.drain(), [
        {
          swept: true
        }
      ]);
      assert.deepEqual(ran, [
        {
          runDate: '2026-06-19'
        }
      ]);
      assert.ok(testState.jobs().some(event =>
        event.type === 'job.completed' &&
        event.jobName === 'maintenance.dailyDigest' &&
        event.scheduleKey === 'daily_digest' &&
        event.scheduledFor === '2026-06-19T09:15:00.000Z'
      ));
    } finally {
      await worker.cleanup();
    }
  });

  it('turns startup schedules into normal job envelopes', async () => {
    let ran = [];
    let job = defineJob({
      name: 'maintenance.dailyDigest',
      input: z.object({
        dryRun: z.boolean()
      }),
      queue: redisQueue({
        name: 'maintenance',
        idempotencyKey: () => 'daily_digest'
      }),
      schedule: cronSchedule({
        key: 'daily_digest',
        cron: '15 * * * *',
        timezone: 'UTC',
        input: () => ({
          dryRun: false
        }),
        runOnStartup: true
      }),
      async run({ input }) {
        ran.push(input);
        return {
          swept: true
        };
      }
    });
    let worker = await startCricketWorker(defineCricketApp({
      logger() {}
    }), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.drain();

      assert.deepEqual(ran, [
        {
          dryRun: false
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

});
