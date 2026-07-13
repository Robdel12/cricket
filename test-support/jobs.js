import {
  concurrency,
  defineCricketApp,
  defineJob,
  redisQueue,
  retry,
  state,
  z
} from '../src/index.js';

export function createManualClock(start) {
  let current = new Date(start);
  let waiters = new Set();
  let observers = [];

  function remove(waiter) {
    waiters.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
  }

  function notifyWait(until) {
    for (let observe of observers.splice(0))
      observe(until);
  }

  function waitUntil(until, {
    signal
  } = {}) {
    let deadline = new Date(until);

    notifyWait(deadline);

    if (deadline <= current)
      return Promise.resolve();

    return new Promise((resolve, reject) => {
      let waiter = {
        deadline,
        signal,
        resolve,
        reject
      };

      waiter.onAbort = () => {
        remove(waiter);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      waiters.add(waiter);
      signal?.addEventListener('abort', waiter.onAbort, {
        once: true
      });
    });
  }

  function advanceTo(value) {
    current = new Date(value);

    for (let waiter of [...waiters]) {
      if (waiter.deadline > current)
        continue;

      remove(waiter);
      waiter.resolve();
    }
  }

  return {
    clock: {
      now: () => new Date(current),
      waitUntil
    },
    advanceBy(milliseconds) {
      advanceTo(current.getTime() + milliseconds);
    },
    advanceTo,
    nextWait() {
      return new Promise(resolve => {
        observers.push(resolve);
      });
    },
    now() {
      return new Date(current);
    }
  };
}

export function deferred() {
  let resolve;
  let reject;
  let promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    reject,
    resolve
  };
}

export function createTestApp(testState, jobs = []) {
  return defineCricketApp({
    domains: [{
      name: 'testJobs',
      jobs
    }],
    observability: {
      observe(event) {
        testState.recordEvent(event);
      }
    },
    logger: {
      info(event, metadata) {
        testState.recordLog({
          level: 'info',
          event,
          metadata
        });
      },
      warn() {},
      error() {},
      child(metadata) {
        return {
          info(event, nextMetadata = {}) {
            testState.recordLog({
              level: 'info',
              event,
              metadata: {
                ...metadata,
                ...nextMetadata
              }
            });
          },
          warn() {},
          error() {},
          child() {
            return this;
          }
        };
      }
    },
    services() {
      return {
        reports: {
          record(input) {
            return {
              recorded: input.reportId
            };
          }
        }
      };
    }
  });
}

export function reportJob(events = [], options = {}) {
  return defineJob({
    name: 'reports.generate',
    input: z.object({
      reportId: z.string(),
      accountId: z.string(),
      templateId: z.string()
    }),
    context: z.object({
      requestId: z.string().optional(),
      source: z.string().optional(),
      priority: z.number().int().default(0)
    }).default({}),
    result: z.object({
      status: z.enum(['completed'])
    }),
    queue: redisQueue({
      name: 'reports',
      idempotencyKey: ({ input }) => input.reportId,
      priority: ({ context }) => context.priority
    }),
    retry: retry.exponential({
      attempts: 2,
      delayMs: 10,
      when: ({ error }) => error.retryable !== false
    }),
    ...(options.failure ? { failure: options.failure } : {}),
    concurrency: [
      concurrency.partition({
        key: ({ input }) => `account:${input.accountId}`,
        limit: 2
      })
    ],
    state: state.derived({
      from: ['accounts', 'reports', 'templates']
    }),
    async run({ input, logger, progress, services, trace }) {
      logger.info('report.started', {
        reportId: input.reportId
      });
      await progress.update({
        current: 1,
        total: 1
      });
      await trace.span('report.persist', {
        accountId: input.accountId
      }, () => services.reports.record(input));

      events.push(input.reportId);

      return {
        status: 'completed'
      };
    }
  });
}
