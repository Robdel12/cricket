import { randomUUID } from 'node:crypto';

import { createCricketRuntime } from '../http/runtime.js';
import {
  logEnvelope,
  resolveLogger
} from '../logger.js';
import {
  createTestClient,
  testRequestIdHeader
} from './client.js';
import { createTestState } from './state.js';

function observersFrom(config) {
  if (!config)
    return [];

  if (typeof config === 'function')
    return [config];

  if (!config.observe)
    return [];

  return Array.isArray(config.observe) ? config.observe : [config.observe];
}

function requestIdFromHeader(context) {
  let value = context.request.headers[testRequestIdHeader];

  return typeof value === 'string' && value ? value : undefined;
}

function appWithTestObservability(app, testState) {
  let original = app.observability;
  let observers = observersFrom(original);

  return {
    ...app,
    observability: {
      requestId(context) {
        return requestIdFromHeader(context)
          ?? original?.requestId?.(context)
          ?? randomUUID();
      },

      async observe(event) {
        testState.recordEvent(event);

        for (let observe of observers)
          await observe(event);
      }
    }
  };
}

function createTestLogger(testState, appLogger, context = {}) {
  let logger = appLogger
    ? resolveLogger(appLogger)
    : undefined;

  function log(level, event, metadata = {}) {
    testState.recordLog(logEnvelope({
      context,
      event,
      level,
      metadata
    }));
    logger?.[level]?.(event, metadata);
  }

  return {
    debug(event, metadata) {
      log('debug', event, metadata);
    },

    info(event, metadata) {
      log('info', event, metadata);
    },

    warn(event, metadata) {
      log('warn', event, metadata);
    },

    error(event, metadata) {
      log('error', event, metadata);
    },

    child(metadata = {}) {
      return createTestLogger(testState, logger?.child?.(metadata), {
        ...context,
        ...metadata
      });
    }
  };
}

function appWithTestLogger(app, testState) {
  return {
    ...app,
    logger: createTestLogger(testState, app.logger)
  };
}

/**
 * @guide testing Test your API
 *
 * The best test hits your API the way a client does. `createTestRuntime` starts your real app on a random port, so your tests run the same routes, rules, and database code as production.
 *
 * ## Write a test
 *
 * Here are the tests from the [example app](../examples/projects/):
 *
 * <!-- example examples/projects/api/domains/projects/behavior.test.js api/domains/projects/behavior.test.js -->
 *
 * The test database is in-memory SQLite, so each test starts fresh after running migrations. The `api` client takes `body`, `headers`, and `query`, and gives you back `status`, `headers`, and `body`.
 *
 * Run them with:
 *
 * ```sh
 * pnpm exec cricket test
 * ```
 *
 * It finds `*.test.js` files under `api/`, `src/`, and `test/`, and sets `NODE_ENV=test` so your app picks its test database.
 *
 * ## What to check
 *
 * Check what a client would notice: status codes, response bodies, validation errors, who's allowed in, and rows that got saved. Don't mock Cricket. Mock only things you don't own, like a payment API or the clock.
 *
 * When you need to look under the hood, `testState` has the logs, traces, and timings for each request:
 *
 * ```js
 * let { api, testState } = await createTestRuntime(app);
 * let response = await api.get('/api/projects/launch-plan');
 *
 * testState.request(response.requestId);
 * ```
 *
 * ## Test jobs
 *
 * Start a worker with the in-memory queue, then run the work yourself. No sleeping, no waiting.
 *
 * ```js
 * let worker = await startCricketWorker(app, {
 *   jobs: [generateReport],
 *   queues: { test: true },
 *   clock: { now: () => new Date('2026-06-19T09:16:00.000Z') }
 * });
 *
 * await worker.jobs.enqueue(generateReport, { reportId: 'r1', accountId: 'a1' });
 * await worker.drain();
 * ```
 *
 * For scheduled jobs, set the clock, call `worker.schedules.tick()`, then `worker.drain()`.
 */
/**
 * Create a Cricket runtime wired for test inspection.
 *
 * The runtime remains a normal Cricket HTTP runtime. The test harness only adds
 * request id correlation, safe log collection, and lifecycle event collection.
 *
 * @param {object} app - Cricket app contract.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - Module URL for domain loading.
 * @param {object} [options.testState] - Existing test state collector.
 * Cleanup closes admission and the listener, awaits accepted requests, then
 * releases dependencies. Apps stop their independent workers/streams first;
 * this helper does not invoke the standalone server's onShutdown hook.
 *
 * @returns {Promise<object>} Bound origin, runtime, HTTP client, test state, and once-only cleanup.
 */
export async function createTestRuntime(app, {
  baseUrl,
  testState = createTestState()
} = {}) {
  let testApp = appWithTestObservability(appWithTestLogger(app, testState), testState);
  let runtime = await createCricketRuntime(testApp, {
    baseUrl
  });
  let api;
  try {
    api = await createTestClient(runtime);
  } catch (error) {
    let errors = [error];
    try {
      await runtime.cleanup();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    throw errors.length === 1 ? error : new AggregateError(errors, 'Test runtime startup failed');
  }
  let cleaning;

  function cleanup() {
    cleaning ??= (async () => {
      let results = await Promise.allSettled([api.cleanup(), runtime.cleanup()]);
      let errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Test runtime cleanup failed');
    })();
    return cleaning;
  }

  return {
    api,
    origin: api.origin,
    runtime,
    testState,
    cleanup
  };
}
