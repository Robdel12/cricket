import { randomUUID } from 'node:crypto';

import { createCricketRuntime } from '../http/runtime.js';
import { logEnvelope } from '../logger.js';
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

function createTestLogger(testState, context = {}) {
  function log(level, event, metadata = {}) {
    testState.recordLog(logEnvelope({
      context,
      event,
      level,
      metadata
    }));
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
      return createTestLogger(testState, {
        ...context,
        ...metadata
      });
    }
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
 * @returns {Promise<{api: object, runtime: object, testState: object, cleanup: Function}>}
 */
export async function createTestRuntime(app, {
  baseUrl,
  testState = createTestState()
} = {}) {
  let runtime = await createCricketRuntime(appWithTestObservability(app, testState), {
    baseUrl,
    logger: createTestLogger(testState)
  });
  let api = await createTestClient(runtime);

  async function cleanup() {
    try {
      await api.cleanup();
    } finally {
      if (runtime.cleanup)
        await runtime.cleanup();
    }
  }

  return {
    api,
    runtime,
    testState,
    cleanup
  };
}
