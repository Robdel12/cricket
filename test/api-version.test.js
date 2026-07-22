import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import {
  created,
  defineApiVersions,
  defineEndpoint,
  defineNormalizer,
    defineRule,
    defineSerializer,
    respond,
    withHeaders,
    z
} from '../src/index.js';
import { createTestRuntime } from '../src/test/index.js';
import {
  createAppMap,
  formatAppMap
} from '../src/app-contract.js';
import { defineManualTestApp } from '../test-support/app.js';

let CurrentCreateSession = z.object({
  circuitId: z.string(),
  durationMinutes: z.number().int().positive(),
  queued: z.boolean().optional()
});
let LegacyCreateSession = z.object({
  circuit_id: z.string(),
  duration_seconds: z.number().int().positive(),
  queued: z.boolean().optional()
});
let CurrentSession = z.object({
  id: z.string(),
  circuitId: z.string(),
  durationMinutes: z.number()
});
let LegacySession = z.object({
  session_id: z.string(),
  circuit_id: z.string(),
  duration_seconds: z.number()
});
let CurrentQueuedSession = z.object({
  jobId: z.string(),
  session: CurrentSession
});
let LegacyQueuedSession = z.object({
  job_id: z.string(),
  result: LegacySession
});

let normalizeLegacyCreateSession = defineNormalizer({
  name: 'session.create.2025-11-15',
  source: LegacyCreateSession,
  output: CurrentCreateSession,
  normalize(value) {
    return {
      circuitId: value.circuit_id,
      durationMinutes: value.duration_seconds / 60,
      queued: value.queued
    };
  }
});
let serializeLegacySession = defineSerializer({
  name: 'session.2025-11-15',
  output: LegacySession,
  serialize(value) {
    return {
      session_id: value.id,
      circuit_id: value.circuitId,
      duration_seconds: value.durationMinutes * 60
    };
  }
});
let serializeLegacyQueuedSession = defineSerializer({
  name: 'session.queued.2025-11-15',
  output: LegacyQueuedSession,
  serialize(value) {
    return {
      job_id: value.jobId,
      result: serializeLegacySession(value.session)
    };
  }
});

function tornadicVersions() {
  return defineApiVersions({
    name: 'tornadic.ios',
    header: 'Tornadic-Version',
    clientHeader: 'Tornadic-App-Version',
    current: '2026-09-01',
    default: '2025-11-15',
    versions: {
      '2025-11-15': {
        deprecatedAt: '2026-09-01T00:00:00.000Z',
        sunsetAt: '2027-09-01T00:00:00.000Z'
      },
      '2026-09-01': {}
    }
  });
}

function versionedEndpoint(family = tornadicVersions()) {
  let requireCanonicalInput = defineRule('requireCanonicalInput', ({ input }) => {
    assert.equal(typeof input.body.durationMinutes, 'number');
    assert.equal(input.body.duration_seconds, undefined);
  });

  return defineEndpoint({
    method: 'post',
    path: '/sessions',
    apiVersions: family({
      '2025-11-15': {
        body: normalizeLegacyCreateSession,
        responses: {
          201: serializeLegacySession,
          202: serializeLegacyQueuedSession
        }
      }
    }),
    body: CurrentCreateSession,
    responses: {
      201: CurrentSession,
      202: CurrentQueuedSession
    },
    rules: [requireCanonicalInput],
    handler({ input, apiVersion }) {
      assert.equal(apiVersion, undefined);

      let session = {
        id: 'session_123',
        circuitId: input.body.circuitId,
        durationMinutes: input.body.durationMinutes
      };

      return input.body.queued
        ? respond(202, {
          jobId: 'job_123',
          session
        })
        : withHeaders(created(session), {
          Vary: 'Accept',
          vary: 'Origin',
          'tornadic-version': 'stale'
        });
    }
  });
}

describe('endpoint API versions', () => {
  it('keeps family and endpoint contracts immutable and rejects invalid wiring', () => {
    let family = tornadicVersions();
    let contract = family({
      '2025-11-15': {
        body: normalizeLegacyCreateSession,
        response: serializeLegacySession
      }
    });

    assert.equal(Object.isFrozen(family), true);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.family.versions), true);
    assert.equal(Object.isFrozen(contract.versions), true);

    assert.throws(() => family({
      '1999-01-01': {}
    }), /Unknown tornadic\.ios API version/);
    assert.throws(() => family({
      '2026-09-01': {}
    }), /uses the endpoint base contract/);
    assert.throws(() => family({
      '2025-11-15': {
        body: value => value
      }
    }), /must be a Cricket normalizer/);
    assert.throws(() => family({
      '2025-11-15': Object.create({
        response: serializeLegacySession
      })
    }), /endpoint contract must be a plain object/);
    assert.throws(() => defineEndpoint({
      method: 'get',
      path: '/inherited-version-contract',
      apiVersions: Object.create(contract),
      handler() {}
    }), /must come from defineApiVersions/);
  });

  it('uses the default contract when direct endpoint handling omits headers', async () => {
    let response = await versionedEndpoint().handle({
      body: {
        circuit_id: 'circuit_direct',
        duration_seconds: 1800
      }
    });

    assert.deepEqual(response.body, {
      session_id: 'session_123',
      circuit_id: 'circuit_direct',
      duration_seconds: 1800
    });
  });

  it('normalizes a pinned legacy request before rules and serializes its response', async () => {
    let app = defineManualTestApp({
      endpoints: [versionedEndpoint()]
    });
    let { api, cleanup, testState } = await createTestRuntime(app);

    try {
      let response = await api.post('/sessions', {
        headers: {
          'Tornadic-App-Version': '1.4.0'
        },
        body: {
          circuit_id: 'circuit_123',
          duration_seconds: 1800
        }
      });

      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        session_id: 'session_123',
        circuit_id: 'circuit_123',
        duration_seconds: 1800
      });
      assert.equal(response.headers['tornadic-version'], '2025-11-15');
      assert.equal(response.headers.vary, 'Accept, Origin, Tornadic-Version');
      assert.match(response.headers.deprecation, /^@\d+$/);
      assert.equal(response.headers.sunset, 'Wed, 01 Sep 2027 00:00:00 GMT');

      let logs = testState.trace(response.requestId).logs;
      let resolved = logs.find(log => log.event === 'http.api_version.resolved');
      let finished = logs.find(log => log.event === 'http.response.finished');

      assert.equal(resolved.metadata.apiVersion, '2025-11-15');
      assert.equal(resolved.metadata.clientVersion, '1.4.0');
      assert.equal(finished.metadata.apiVersion, '2025-11-15');
    } finally {
      await cleanup();
    }
  });

  it('uses the current base contract and status-specific legacy serializers', async () => {
    let app = defineManualTestApp({
      endpoints: [versionedEndpoint()]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let current = await api.post('/sessions', {
        headers: {
          'Tornadic-Version': '2026-09-01'
        },
        body: {
          circuitId: 'circuit_current',
          durationMinutes: 30
        }
      });
      let queuedLegacy = await api.post('/sessions', {
        body: {
          circuit_id: 'circuit_queued',
          duration_seconds: 1200,
          queued: true
        }
      });

      assert.deepEqual(current.body, {
        id: 'session_123',
        circuitId: 'circuit_current',
        durationMinutes: 30
      });
      assert.deepEqual(queuedLegacy.body, {
        job_id: 'job_123',
        result: {
          session_id: 'session_123',
          circuit_id: 'circuit_queued',
          duration_seconds: 1200
        }
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects unsupported and duplicate versions without exposing their values', async () => {
    let app = defineManualTestApp({
      endpoints: [versionedEndpoint()]
    });
    let runtime = await createTestRuntime(app);

    try {
      let unsupported = await runtime.api.post('/sessions', {
        headers: {
          'Tornadic-Version': 'private-unknown-version'
        },
        body: {}
      });
      let duplicate = await request(runtime.runtime.app)
        .post('/sessions')
        .set('Tornadic-Version', ['2025-11-15', '2026-09-01'])
        .send({});
      let inheritedName = await runtime.api.post('/sessions', {
        headers: {
          'Tornadic-Version': 'toString'
        },
        body: {}
      });

      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.headers.vary, 'Tornadic-Version');
      assert.equal(unsupported.body.error.code, 'BAD_REQUEST');
      assert.equal(JSON.stringify(unsupported.body).includes('private-unknown-version'), false);
      assert.equal(duplicate.status, 400);
      assert.equal(duplicate.headers.vary, 'Tornadic-Version');
      assert.equal(inheritedName.status, 400);
      assert.equal(JSON.stringify(runtime.testState.report()).includes('private-unknown-version'), false);
    } finally {
      await runtime.cleanup();
    }
  });

  it('keeps negotiated metadata on validation and redacted serializer failures', async () => {
    let family = tornadicVersions();
    let brokenSerializer = defineSerializer({
      name: 'session.broken.legacy',
      output: z.object({
        required: z.string()
      }),
      serialize() {
        return {};
      }
    });
    let brokenEndpoint = defineEndpoint({
      method: 'get',
      path: '/broken-session',
      apiVersions: family({
        '2025-11-15': {
          response: brokenSerializer
        }
      }),
      response: CurrentSession,
      handler() {
        return {
          id: 'session_123',
          circuitId: 'circuit_123',
          durationMinutes: 30
        };
      }
    });
    let app = defineManualTestApp({
      endpoints: [versionedEndpoint(family), brokenEndpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let invalid = await api.post('/sessions', {
        body: {}
      });
      let broken = await api.get('/broken-session');

      assert.equal(invalid.status, 422);
      assert.equal(invalid.headers['tornadic-version'], '2025-11-15');
      assert.equal(broken.status, 500);
      assert.equal(broken.headers['tornadic-version'], '2025-11-15');
      assert.deepEqual(broken.body, {
        error: {
          code: 'SERIALIZER_CONTRACT_FAILED',
          message: 'Internal server error'
        }
      });
    } finally {
      await cleanup();
    }
  });

  it('leaves endpoints without apiVersions completely unchanged', async () => {
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/health',
      response: z.object({
        healthy: z.literal(true),
        hasApiVersion: z.literal(false)
      }),
      handler(context) {
        return {
          healthy: true,
          hasApiVersion: Object.hasOwn(context, 'apiVersion')
        };
      }
    });
    let app = defineManualTestApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let response = await api.get('/health', {
        headers: {
          'Tornadic-Version': 'retired-or-invalid'
        }
      });

      assert.equal(Object.hasOwn(endpoint, 'apiVersions'), false);
      let appMap = createAppMap(app);
      assert.equal(Object.hasOwn(appMap, 'apiVersions'), false);
      assert.equal(Object.hasOwn(appMap.routes[0], 'apiVersions'), false);
      assert.deepEqual(response.body, {
        healthy: true,
        hasApiVersion: false
      });
      assert.equal(response.headers['tornadic-version'], undefined);
      assert.equal(response.headers.vary, undefined);
    } finally {
      await cleanup();
    }
  });

  it('discovers shared version families and endpoint deltas for inspect', () => {
    let versioned = versionedEndpoint();
    let unversioned = defineEndpoint({
      method: 'get',
      path: '/health',
      handler() {
        return { healthy: true };
      }
    });
    let map = createAppMap(defineManualTestApp({
      endpoints: [versioned, unversioned]
    }));
    let output = formatAppMap(map);

    assert.deepEqual(map.apiVersions, [{
      name: 'tornadic.ios',
      header: 'Tornadic-Version',
      clientHeader: 'Tornadic-App-Version',
      current: '2026-09-01',
      default: '2025-11-15',
      versions: ['2025-11-15', '2026-09-01']
    }]);
    assert.deepEqual(map.routes[0].apiVersions, {
      family: 'tornadic.ios',
      deltas: ['2025-11-15']
    });
    assert.equal(Object.hasOwn(map.routes[1], 'apiVersions'), false);
    assert.match(output, /API versions\n  tornadic\.ios/);
    assert.match(output, /compatibility deltas: 2025-11-15/);
  });

  it('composes three installed client generations on one endpoint', async () => {
    let family = defineApiVersions({
      name: 'tornadic.ios.generations',
      header: 'Tornadic-Version',
      current: '2027-06-01',
      default: '2025-11-15',
      versions: {
        '2025-11-15': {},
        '2026-09-01': {},
        '2027-06-01': {}
      }
    });
    let oldest = defineSerializer({
      name: 'session.2025-11-15',
      output: z.object({
        session_id: z.string()
      }),
      serialize(value) {
        return {
          session_id: value.session.id
        };
      }
    });
    let previous = defineSerializer({
      name: 'session.2026-09-01',
      output: z.object({
        id: z.string()
      }),
      serialize(value) {
        return {
          id: value.session.id
        };
      }
    });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/generation-session',
      apiVersions: family({
        '2025-11-15': {
          response: oldest
        },
        '2026-09-01': {
          response: previous
        }
      }),
      response: z.object({
        session: z.object({
          id: z.string()
        })
      }),
      handler() {
        return {
          session: {
            id: 'session_123'
          }
        };
      }
    });
    let app = defineManualTestApp({
      endpoints: [endpoint]
    });
    let { api, cleanup } = await createTestRuntime(app);

    try {
      let first = await api.get('/generation-session');
      let second = await api.get('/generation-session', {
        headers: {
          'Tornadic-Version': '2026-09-01'
        }
      });
      let third = await api.get('/generation-session', {
        headers: {
          'Tornadic-Version': '2027-06-01'
        }
      });

      assert.deepEqual(first.body, {
        session_id: 'session_123'
      });
      assert.deepEqual(second.body, {
        id: 'session_123'
      });
      assert.deepEqual(third.body, {
        session: {
          id: 'session_123'
        }
      });
    } finally {
      await cleanup();
    }
  });
});
