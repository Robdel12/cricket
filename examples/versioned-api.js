import {
  defineApiVersions,
  defineEndpoint,
  defineNormalizer,
  defineSerializer,
  z
} from '@robdel12/cricket';

let CurrentSessionInput = z.object({
  durationMinutes: z.number().int().positive()
});
let LegacySessionInput = z.object({
  duration_seconds: z.number().int().positive().multipleOf(60)
});
let CurrentSession = z.object({
  id: z.string(),
  durationMinutes: z.number()
});
let LegacySession = z.object({
  session_id: z.string(),
  duration_seconds: z.number()
});

let normalizeLegacySession = defineNormalizer({
  name: 'session.create.2025-11-15',
  source: LegacySessionInput,
  output: CurrentSessionInput,
  normalize(value) {
    return {
      durationMinutes: value.duration_seconds / 60
    };
  }
});

let serializeLegacySession = defineSerializer({
  name: 'session.2025-11-15',
  output: LegacySession,
  serialize(value) {
    return {
      session_id: value.id,
      duration_seconds: value.durationMinutes * 60
    };
  }
});

export let sdkVersions = defineApiVersions({
  name: 'sessions.sdk',
  header: 'Sessions-Version',
  current: '2026-09-01',
  default: '2025-11-15',
  versions: {
    '2025-11-15': {},
    '2026-09-01': {}
  }
});

export let createSession = defineEndpoint({
  method: 'post',
  path: '/sessions',
  apiVersions: sdkVersions({
    '2025-11-15': {
      body: normalizeLegacySession,
      response: serializeLegacySession
    }
  }),
  body: CurrentSessionInput,
  response: CurrentSession,
  handler({ input }) {
    return {
      id: 'session_123',
      durationMinutes: input.body.durationMinutes
    };
  }
});
