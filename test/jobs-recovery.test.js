import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  z
} from '../src/index.js';
import { createTestState } from '../src/test/index.js';
import { createTestApp } from '../test-support/jobs.js';

describe('Cricket jobs: recovery', () => {
  it('recovers an active claimed job by retrying from normal job signals', async () => {
    let processed = [];
    let productEvents = [];
    let testState = createTestState();
    let job = defineJob({
      name: 'reports.recover',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      failure: jobFailure({
        async retrying({ input, failure }) {
          productEvents.push({
            reportId: input.reportId,
            reason: failure.code
          });
        }
      }),
      recover({
        logs
      }) {
        if (!logs.seen('report.started', {
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'report_never_started',
              message: 'report job was claimed but never started'
            }
          };

        return {
          action: 'continue'
        };
      },
      async run({
        input,
        logger
      }) {
        logger.info('report.started', {
          reportId: input.reportId
        });
        processed.push(input.reportId);

        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_recovered'
      });

      let interrupted = await worker.driver.claim();

      assert.equal(interrupted.envelope.name, 'reports.recover');

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'retry');
      assert.equal(recovery[0].decision.reason.code, 'report_never_started');
      assert.ok(testState.jobs().some(event =>
        event.type === 'job.recovery.decided' &&
        event.decision.action === 'retry'
      ));
      assert.ok(testState.jobs().some(event => event.type === 'job.retry_scheduled'));

      assert.deepEqual(await worker.drain(), [
        {
          status: 'completed'
        }
      ]);
      assert.deepEqual(processed, ['report_recovered']);
      assert.deepEqual(productEvents, [
        {
          reportId: 'report_recovered',
          reason: 'report_never_started'
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('keeps an active job running when recovery sees fresh logs and progress', async () => {
    let testState = createTestState();
    let releaseJob;
    let started = new Promise(resolve => {
      releaseJob = resolve;
    });
    let finishJob;
    let finished = new Promise(resolve => {
      finishJob = resolve;
    });
    let decisions = [];
    let job = defineJob({
      name: 'reports.long',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        logs,
        progress,
        run
      }) {
        decisions.push({
          heartbeat: Boolean(run.lastHeartbeatAt),
          logSeen: logs.seen('report.started', {
            within: '5 minutes'
          }),
          progressSeen: progress.seen({
            within: '5 minutes'
          })
        });

        if (!logs.seen('report.started', {
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'missing_report_log'
            }
          };

        if (!progress.seen({
          within: '5 minutes'
        }))
          return {
            action: 'retry',
            reason: {
              code: 'missing_report_progress'
            }
          };

        return {
          action: 'continue'
        };
      },
      async run({
        logger,
        progress
      }) {
        logger.info('report.started');
        await progress.update({
          phase: 'waiting'
        });
        releaseJob();
        await finished;

        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_long'
      });

      let drain = worker.drain();

      await started;

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'continue');
      assert.deepEqual(decisions, [
        {
          heartbeat: true,
          logSeen: true,
          progressSeen: true
        }
      ]);

      finishJob();

      assert.deepEqual(await drain, [
        {
          status: 'completed'
        }
      ]);
    } finally {
      finishJob();
      await worker.cleanup();
    }
  });

  it('records normal logs and spans emitted by recovery', async () => {
    let recoveries = [];
    let job = defineJob({
      name: 'reports.recoverySignals',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      async recover({
        logs,
        spans,
        logger,
        trace
      }) {
        recoveries.push({
          logSeen: logs.seen('recovery.checked'),
          spanSeen: spans.seen('recovery.inspect')
        });

        logger.info('recovery.checked');
        await trace.span('recovery.inspect', {}, () => undefined);

        return {
          action: 'continue'
        };
      },
      async run() {
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_recovery_signals'
      });

      await worker.driver.claim();
      await worker.recover();
      await worker.recover();

      assert.deepEqual(recoveries, [
        {
          logSeen: false,
          spanSeen: false
        },
        {
          logSeen: true,
          spanSeen: true
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

  it('does not let a late completion overwrite a recovery retry', async () => {
    let testState = createTestState();
    let releaseFirstRun;
    let firstRunStarted = new Promise(resolve => {
      releaseFirstRun = resolve;
    });
    let finishFirstRun;
    let firstRunFinished = new Promise(resolve => {
      finishFirstRun = resolve;
    });
    let runs = [];
    let job = defineJob({
      name: 'reports.lateComplete',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover() {
        return {
          action: 'retry',
          reason: {
            code: 'claimed_worker_lost'
          }
        };
      },
      async run({
        input
      }) {
        runs.push(input.reportId);

        if (runs.length === 1) {
          releaseFirstRun();
          await firstRunFinished;
        }

        return {
          status: 'completed',
          attempt: runs.length
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(testState), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_late_complete'
      });

      let firstDrain = worker.drain();

      await firstRunStarted;

      let recovery = await worker.recover();

      assert.equal(recovery[0].decision.action, 'retry');

      finishFirstRun();

      assert.deepEqual(await firstDrain, [
        undefined,
        {
          status: 'completed',
          attempt: 2
        }
      ]);
      assert.deepEqual(runs, ['report_late_complete', 'report_late_complete']);
      assert.equal(testState.jobs().filter(event => event.type === 'job.completed').length, 1);
    } finally {
      finishFirstRun();
      await worker.cleanup();
    }
  });

  it('clears recovery evidence when retrying into a new active attempt', async () => {
    let recoveries = [];
    let job = defineJob({
      name: 'reports.retryFreshEvidence',
      input: z.object({
        reportId: z.string()
      }),
      queue: redisQueue({
        name: 'reports'
      }),
      recover({
        logs,
        progress
      }) {
        recoveries.push({
          logSeen: logs.seen('report.started'),
          progressSeen: progress.seen({
            within: '5 minutes'
          })
        });

        return {
          action: 'retry',
          reason: {
            code: 'force_retry'
          }
        };
      },
      async run() {
        return {
          status: 'completed'
        };
      }
    });
    let worker = await startCricketWorker(createTestApp(createTestState()), {
      jobs: [job],
      queues: {
        test: true
      }
    });

    try {
      await worker.jobs.enqueue(job, {
        reportId: 'report_retry_fresh_evidence'
      });

      let firstAttempt = await worker.driver.claim();

      await worker.driver.recordLog(firstAttempt.envelope, {
        level: 'info',
        event: 'report.started'
      });
      await worker.driver.progress(firstAttempt.envelope, {
        phase: 'first'
      });
      await worker.recover();

      let secondAttempt = await worker.driver.claim();

      assert.equal(secondAttempt.attempt, 2);

      await worker.recover();

      assert.deepEqual(recoveries, [
        {
          logSeen: true,
          progressSeen: true
        },
        {
          logSeen: false,
          progressSeen: false
        }
      ]);
    } finally {
      await worker.cleanup();
    }
  });

});
