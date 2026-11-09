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
