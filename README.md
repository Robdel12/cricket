# Cricket

Tiny contracts for sturdy Node APIs.

Cricket gives Node APIs the backend shape that stays pleasant as the app grows:
plain JavaScript, Zod contracts, predictable domain files, thin routes, boring
services, first-class jobs, OpenAPI generation, and a normal Node entrypoint.

No model instances. No hidden mutation. No ORM lifecycle. Your app passes plain
objects around, composes functions, and keeps side effects at the edges.

## Install

```sh
pnpm add @robdel12/cricket
```

## Adopt Cricket

Start with the complete structured app and agent contract:

```sh
pnpm cricket init .
pnpm cricket check api/index.js
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
```

`init` creates the folders Cricket expects, adds the Cricket section to
`AGENTS.md`, and installs a small local skill suite under `.agents/skills/`:

- `cricket` teaches the framework shape, domain pattern, and change flow.
- `cricket-jobs` teaches jobs, schedules, retries, workers, and the ledger.
- `cricket-observability` teaches logging, tracing, lifecycle, and debugging.
- `cricket-testing` teaches HTTP-boundary tests, worker-boundary job tests, and
  Cricket test state.

That skill suite is part of Cricket's docs surface. It exists because Cricket is
meant to be easy for agents to use correctly while humans drive the product
decisions.

`init app` and `init agents` remain available as focused commands for existing
projects, but `init .` is the normal adoption path.

In this repo, the canonical scaffolded guidance lives in
`src/templates/agents/`, including each skill's real `SKILL.md` file.

## Principles

- Keep data plain: objects in, objects out.
- Keep side effects at clear boundaries: services, handlers, jobs, middleware,
  migrations, and external clients.
- Keep contracts at real edges: requests, responses, source payloads, jobs, and
  database rows.
- Keep definitions stable: app, endpoint, rule, model, serializer, normalizer,
  and job contracts cannot drift after construction. Cricket owns immutable
  contract structure without freezing caller-owned runtime values.
- Keep domain files predictable. Agents should be able to guess where behavior
  lives before they open the repo.
- Keep framework behavior visible. Cricket provides runtime shape; your app
  defines product behavior, auth policy, data policy, worker entrypoints,
  health checks, and deployment.

## App Shape

```text
api/
  index.js      app entrypoint and Cricket wiring
  domains/      product API domains
  middleware/   request middleware
  services/     app-wide capabilities
  workers/      background worker entrypoints
  migrations/   app database migrations
  dev/          local-only support
```

Use `domains/` for product behavior. Use `middleware/` for HTTP edge work such
as auth extraction, CORS, request IDs, raw webhooks, and frontend fallbacks. Use
`services/` for narrow shared capabilities like mail, storage, payments, caches,
and external clients. Use `workers/` for background entrypoints that start
Cricket workers. Use `dev/` only for local support.

If code affects product behavior, put it in a domain, app service, worker,
middleware, or migration. Avoid generic junk drawers.

### Manual architecture is migration debt

Cricket requires a `domains` contract by default. Structured apps cannot
register `endpoints`, `jobs`, or `models` directly on `defineCricketApp`; those
contracts must come from domains.

Existing or embedded applications can temporarily opt out:

```js
export let app = defineCricketApp({
  architecture: 'manual',
  endpoints: legacyEndpoints
});
```

Manual architecture is an escape hatch, not a second recommended application
shape. Treat it as visible tech debt while migrating an existing app. Cricket
labels it in `inspect` and `check`; remove it once product contracts live in
domains. Manual mode cannot be mixed with `domains`, so the final cutover is
deliberate and direct rather than a permanent hybrid architecture.

## Domain Shape

Use one folder per domain.

```text
api/domains/project/
  schema.model.js         row contracts and visibility
  input.validations.js    request/source/service input schemas
  source.normalizers.js   outside payload projections
  output.serializers.js   API output projections
  domain.service.js       data and product operations
  access.rules.js         auth, existence, ownership, business guards
  http.routes.js          endpoint contracts
  *.jobs.js               background job contracts
  behavior.test.js        HTTP and worker-boundary tests
```

The folder is the domain. Cricket auto-loads direct domain-local files by
suffix, such as `*.model.js`, `*.routes.js`, and `*.jobs.js`. Optional files
stay optional, and filenames can describe the slice they contain.

## App Entry

Put the app contract in `api/index.js`.

```js
import { defineCricketApp, startCricketApp } from '@robdel12/cricket';

export let app = defineCricketApp({
  name: 'Project API',
  version: '1.0.0',
  prefix: '/api',
  logger: {
    service: 'project-api',
    level: process.env.LOG_LEVEL ?? 'info'
  },
  database: {
    client: 'pg',
    defaultEnvironment: 'development',
    environments: {
      development: {
        connection: process.env.DATABASE_URL
      },
      test: {
        client: 'sqlite3',
        connection: {
          filename: ':memory:'
        },
        useNullAsDefault: true
      },
      production: {
        connection: process.env.DATABASE_URL
      }
    }
  },
  domains: './domains',
  async setup({ db }) {
    return {
      services: {
        projects: createProjectService({ db })
      }
    };
  }
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, {
    port: process.env.PORT || 3000,
    main: import.meta.url
  });
```

`setup` returns `undefined` or one explicit object with `dependencies`,
`services`, and `cleanup`. Cricket adds its configured `db` to dependencies;
apps must not return a second `db`.

Capabilities follow the runtime phase that owns them. Setup receives the app,
database, lifecycle, logger, and a no-op startup trace. Domain services, the
app service composer, and middleware initialization receive dependencies,
lifecycle, and logger before requests exist. Request context, rules, and
handlers receive the request logger and trace plus services, lifecycle, and
setup dependencies. Job `run` and failure handlers receive services, lifecycle,
logger, trace, jobs, and progress. Recovery receives execution evidence, time,
logger, and trace because it returns a pure decision rather than doing product
work. Shutdown hooks receive the assembled runtime, including dependencies,
services, lifecycle, and logger.

## Domain Contracts

Models describe durable rows and default visibility:

```js
import { defineModel, field, z } from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: {
    id: field.public(z.uuid()),
    owner_id: field.private(z.uuid(), { sensitive: true }),
    slug: field.public(z.string()),
    name: field.public(z.string())
  }
});
```

Validations are reusable Zod schemas for data entering a boundary:

```js
import { z } from '@robdel12/cricket';

export let ProjectCreateInput = z.object({
  slug: z.string().min(3),
  name: z.string().min(1)
});

export let ProjectInsert = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  slug: z.string().min(3),
  name: z.string().min(1)
});

export let ProjectParams = z.object({
  slug: z.string().min(3)
});
```

Normalizers turn outside payloads into app shapes. Serializers turn domain data
into API output shapes. Both should be pure.

```js
import { defineSerializer, pickFields } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export let serializeProjectPublic = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});
```

Services do data and product work without knowing about HTTP:

```js
import { randomUUID } from 'node:crypto';
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './schema.model.js';
import { ProjectInsert } from './input.validations.js';

export function createProjectService({ db }) {
  let projects = createKnexRepository({
    db,
    model: Project,
    insert: ProjectInsert
  });

  return {
    async createForUser({ userId, slug, name }) {
      return await projects.insert({
        id: randomUUID(),
        owner_id: userId,
        slug,
        name
      });
    }
  };
}
```

Rules answer whether the request can continue. Routes compose validation, rules,
handlers, serializers, response contracts, and docs metadata.

```js
import { created, defineEndpoint, z } from '@robdel12/cricket';
import { Project } from './schema.model.js';
import { serializeProjectPublic } from './output.serializers.js';
import { ProjectCreateInput } from './input.validations.js';
import { requireUser, slugAvailable } from './access.rules.js';

export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  body: ProjectCreateInput,
  rules: [
    requireUser,
    slugAvailable
  ],
  response: z.object({
    success: z.literal(true),
    project: Project.public
  }),
  async handler({ input, services, user }) {
    let project = await services.projects.createForUser({
      userId: user.id,
      ...input.body
    });

    return created({
      success: true,
      project: serializeProjectPublic(project)
    });
  }
});
```

Definition builders reject unknown app and endpoint options so misspelled
wiring fails immediately instead of becoming unused metadata.

### Endpoint responses

Bare values returned by handlers, middleware, and fallbacks are response bodies.
Only Cricket's response functions control HTTP transport details, so a domain
object containing fields such as `status`, `headers`, or `redirect` stays a
normal JSON body.

Request validation failures may include useful issues for API clients. Response,
serializer, and normalizer contract failures remain detailed in logs and
`onError`, but their HTTP response is a redacted internal error.

```js
import {
  ok,
  redirect,
  respond,
  withCookies,
  withHeaders,
  withResponseCleanup
} from '@robdel12/cricket';

return withHeaders(respond(202, {
  queued: true
}), {
  'Retry-After': '5'
});

return withCookies(ok({
  signedIn: true
}), [{
  name: 'session',
  value: session.id,
  options: {
    httpOnly: true,
    secure: true
  }
}]);

return redirect('/projects', 303);

return withResponseCleanup(
  withHeaders(ok(stream), {
    'Content-Type': 'text/event-stream'
  }),
  () => stream.destroy()
);
```

Use `ok(body)` for 200, `created(body)` for 201, and `respond(status, body)` for
other statuses. Compose `withHeaders`, `withCookies`, and
`withResponseCleanup` around an explicit response. Streams and buffers remain
ordinary body values; the helpers add transport intent without wrapping them in
a mutable response builder.

## Database

Cricket uses Knex as the database path. It creates one `db` handle for the
runtime, passes it through app capabilities, and destroys it during cleanup.

Migrations live in `api/migrations/` by convention:

```sh
pnpm cricket migrate make api/index.js create_projects
pnpm cricket migrate latest api/index.js
pnpm cricket migrate status api/index.js
pnpm cricket migrate rollback api/index.js
```

Cricket does not run migrations on server start, design tables, hide data
policy, or replace Knex. It makes the database contract visible from the same
app definition your server uses.

## Jobs

Jobs are Cricket contracts for background work. Use them when work needs
validated input, immutable envelopes, explicit queue coordination, scheduled
execution, recovery, failure handling, logs, traces, progress, and the same
services your HTTP handlers use.

```js
import { z } from '@robdel12/cricket';
import {
  concurrency,
  createCricketJobs,
  cronSchedule,
  defineJob,
  jobFailure,
  redisQueue,
  retry
} from '@robdel12/cricket/jobs';

export let generateReport = defineJob({
  name: 'reports.generate',
  input: z.object({
    reportId: z.string(),
    accountId: z.string()
  }),
  context: z.object({
    priority: z.number().int().default(0)
  }).default({}),
  queue: redisQueue({
    name: 'reports',
    idempotencyKey: ({ input }) => input.reportId,
    priority: ({ context }) => context.priority
  }),
  concurrency: [
    concurrency.global({
      key: 'reports:rendering',
      limit: 4
    }),
    concurrency.partition({
      key: ({ input }) => `account:${input.accountId}`,
      limit: 1
    })
  ],
  retry: retry.exponential({
    attempts: 3,
    delayMs: 2_000,
    maxDelayMs: 60_000
  }),
  recover({ run, logs, progress }) {
    if (run.heartbeatAgeMs > 2 * 60_000)
      return {
        action: 'retry',
        reason: {
          code: 'heartbeat_stale',
          message: 'worker heartbeat is stale'
        }
      };

    if (run.ageMs > 5 * 60_000 && !logs.seen('report.started', { within: '5 minutes' }))
      return {
        action: 'retry',
        reason: {
          code: 'report_never_started',
          message: 'report job never started'
        }
      };

    if (run.ageMs > 10 * 60_000 && !progress.seen({ within: '10 minutes' }))
      return {
        action: 'retry',
        reason: {
          code: 'report_not_advancing',
          message: 'report job stopped reporting progress'
        }
      };

    return { action: 'continue' };
  },
  failure: jobFailure({
    async exhausted({ input, failure, services }) {
      await services.reports.markFailed({
        reportId: input.reportId,
        reason: failure.message
      });
    }
  }),
  schedule: cronSchedule({
    key: 'daily-reports',
    cron: '15 4 * * *',
    timezone: 'America/Chicago',
    input: ({ scheduledFor }) => ({
      reportId: `daily:${scheduledFor.slice(0, 10)}`,
      accountId: 'system'
    })
  }),
  async run({ input, logger, services, trace, progress }) {
    logger.info('report.started', {
      reportId: input.reportId
    });
    await progress.update({ current: 1, total: 1 });
    return trace.span('reports.generate', {
      accountId: input.accountId
    }, () => services.reports.generate(input));
  }
});
```

Producer entrypoints enqueue without starting a worker:

```js
let producer = await createCricketJobs({
  jobs: [generateReport],
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  }
});

await producer.jobs.enqueue(generateReport, {
  reportId,
  accountId
});
```

Worker entrypoints execute jobs:

```js
import { startCricketWorker } from '@robdel12/cricket/jobs';
import { app } from '../index.js';
import { generateReport } from '../domains/reports/reporting.jobs.js';

let worker = await startCricketWorker(app, {
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  },
  jobs: [generateReport]
});

let shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());

try {
  await worker.run({
    signal: shutdown.signal
  });
} finally {
  await worker.cleanup();
}
```

In domain architecture, a worker may execute all app jobs or select a subset,
but every selected job must already belong to one of the app's domains. Manual
apps may register jobs at the worker boundary while they migrate that ownership.

Choose the queue deliberately. Production producers and workers use
`queues.redis` or an app-provided `queues.driver`; tests opt into the in-memory
driver with `queues.test: true`. Cricket never silently turns a missing queue
configuration into an in-memory worker.

The built-in Redis client accepts `redis://` and `rediss://` URLs, including ACL
credentials and a numeric database path. `rediss://` verifies certificates by
default; pass Node TLS options as `queues.redis.tls` when the deployment uses a
private CA. An app-provided client must implement `duplicate()` so blocking
wakeups never stall normal Redis commands. The built-in driver targets a
standalone Redis primary; Redis Cluster is not supported by the built-in
driver.

`worker.run({ signal })` blocks on queue wakeups and the next delayed or cron
boundary. Enqueuing ready work wakes it immediately. Aborting the signal or
calling `worker.cleanup()` stops the wait without a polling interval.

Exponential retries use the job policy as execution behavior. The first retry
waits `delayMs`, each later retry doubles that delay, and `maxDelayMs` caps it.
The retry stays unclaimable until that calculated availability time, while the
original immutable envelope stays unchanged.

Queue policy travels with that immutable envelope. Claims prefer higher numeric
priority among the ready work observed for that claim; equal priorities use
creation time and then envelope ID for stable order. Work enqueued during a
claim becomes eligible on the next claim.

Global concurrency limits shared work, while partition limits keep one account
or tenant from consuming all capacity. A blocked partition does not prevent
another partition from running. Drivers evaluate the resolved envelope policy
when choosing work. Redis atomically verifies and reserves capacity for the
selected envelope, so simultaneous workers cannot over-claim a shared limit.

An idempotency key owns one unfinished run. Duplicate enqueue attempts return
the existing envelope while it is queued, delayed, active, or retrying. Cricket
releases the key after completion or final failure so a later run can start.
Each claimed attempt owns Cricket's lease, evidence, retry, and
completion/failure writes; the driver rejects those writes from older attempts.
Apps must still make product-side effects idempotent or attempt-aware. Delayed
promotion and schedule-slot materialization use the same atomic coordination
boundary.

Envelopes, run state, events, current-attempt evidence, and schedule-slot
ownership remain after a job completes or fails. The app chooses how long to
keep that execution history and when cleanup runs. Pass the expired ledger IDs
to `jobs.removeFinished(ids)`; Cricket verifies each job is completed or failed
and removes its Redis records without exposing their key layout. The result
separates `removed`, already-`missing`, and `skipped` IDs. Treat both `removed`
and `missing` as safe to delete from `cricket_jobs`; leave `skipped` rows for a
later run or operator review.

Run Redis cleanup before deleting ledger rows. If cleanup stops between those
steps, the next run reports the already-clean Redis IDs as `missing` and can
finish deleting the rows. Keep completed and failed retention windows, batch
size, and cleanup scheduling in app code.

```js
async function removeExpiredJobHistory({ jobs, jobHistory, policy }) {
  let expired = await jobHistory.expired(policy);
  let result = await jobs.removeFinished(expired.map(row => row.id));

  await jobHistory.removeExpired([
    ...result.removed,
    ...result.missing
  ], policy);

  return result;
}
```

The app service should recheck the job status and applicable cutoff when it
deletes each row. Cricket does not choose retention windows or schedule this
work.

`worker.cleanup()` closes runtime resources and driver-owned Redis connections;
the app still owns any client it supplied. Cleanup does not delete coordination
records.

If the app has a Cricket database, add the job ledger deliberately:

```js
import { createJobLedgerTable } from '@robdel12/cricket/jobs';

export async function up(db) {
  await createJobLedgerTable(db);
}

export async function down(db) {
  await db.schema.dropTableIfExists('cricket_jobs');
}
```

The ledger is execution history for debugging and operators. It is not product
state.

Recovery is app-owned. Cricket renews an active claim's heartbeat while its
`run` function is working and records normal logs, spans, progress, and driver
run state. Your `recover` function reads that snapshot, including heartbeat age
and ledger-shaped run facts, then returns a plain decision:

```js
return { action: 'continue' };
return { action: 'retry', reason: { code: 'worker_lost' } };
return { action: 'fail', reason: { code: 'outside_business_window' } };
```

Use logs for domain breadcrumbs, `trace.span()` for timed work, and
`progress.update()` for human-readable progress. Cricket does not define
"stuck" for you. The job does. Multiple recoverers may evaluate the same
attempt, so keep recovery pure and idempotent. Cricket fences the resulting
transition and reports `applied: false` when a live attempt still owns its
lease. The optional `cricket_jobs` database ledger remains separate execution
history; recovery does not require it.

## Observability

Cricket provides one logger shape, request/job events, sparse timings, trace
spans, and lifecycle state.

```js
export let app = defineCricketApp({
  domains: './domains',
  logger: {
    service: 'project-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  }
});
```

Use `trace.span(name, metadata, fn)` around meaningful service calls, external
calls, and job steps. Use `pnpm cricket trace` when you need to inspect one
request from newline-delimited JSON logs:

```sh
docker logs api | pnpm cricket trace req_123
```

Apps can read `lifecycle` from setup, services, middleware, context, handlers,
job execution, and shutdown hooks. Worker runtimes expose it for worker
entrypoints. Product health checks still decide whether the app is ready for
traffic.

## Testing

Test through the boundary users consume. Use HTTP tests for endpoints and the
worker boundary for jobs.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestRuntime } from '@robdel12/cricket/test';
import { app } from '../api/index.js';

test('creates a project through the API', async () => {
  let { api, cleanup, testState } = await createTestRuntime(app);

  try {
    let response = await api.post('/api/projects', {
      body: {
        slug: 'launch-plan',
        name: 'Launch Plan'
      }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.project.slug, 'launch-plan');

    let request = testState.request(response.requestId);
    assert.equal(request.response.status, 201);
  } finally {
    await cleanup();
  }
});
```

Drive scheduled jobs without waiting on wall time:

```js
let worker = await startCricketWorker(app, {
  jobs: [generateReport],
  queues: {
    test: true
  },
  clock: {
    now: () => new Date('2026-06-19T09:16:00.000Z')
  }
});

await worker.schedules.tick();
await worker.drain();
```

Direct `tick()` and `drain()` tests only need `clock.now`. If a test exercises
the continuous `worker.run()` loop with a custom clock, provide
`clock.waitUntil` too so the test owns deadline advancement without sleeping.

`testState` exposes events, logs, request traces, job traces, timings, and
runtime reports. It does not reset app state for you.

## CLI

```sh
pnpm cricket init .
pnpm cricket new domain project api/domains --with model,validations,service,routes,test
pnpm cricket inspect api/index.js
pnpm cricket check api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate latest api/index.js
pnpm cricket test
```

`new domain` requires `--with` so optional files exist only when the domain
needs them; use `--with all` when every supported file is intentional. A
selected test starts as a todo until it proves behavior through the HTTP or
worker boundary. The serializer scaffold requires a model in the same selection
or an existing `schema.model.js` in the domain.
`check` validates the app architecture and calls out manual migration debt.
`inspect` prints architecture, loaded domains, model visibility, rules, services, jobs, route
operation IDs, and observability posture. `docs` writes OpenAPI from the same
app module your server runs. `test` wraps Node's built-in test runner with
Cricket defaults and optional JSON output.

## Exports

```js
import {
  defineCricketApp,
  startCricketApp,
  createCricketRuntime,
  defineEndpoint,
  deprecateEndpoint,
  respond,
  ok,
  created,
  redirect,
  withHeaders,
  withCookies,
  withResponseCleanup,
  defineModel,
  defineRule,
  defineSerializer,
  defineNormalizer,
  field,
  createKnexRepository,
  z
} from '@robdel12/cricket';

import {
  concurrency,
  createCricketJobs,
  createJobLedgerTable,
  cronSchedule,
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  state
} from '@robdel12/cricket/jobs';
```

Public subpaths are also available:

```js
import { defineCricketApp } from '@robdel12/cricket/app';
import { loadDomains } from '@robdel12/cricket/domain';
import { createKnexRepository } from '@robdel12/cricket/knex';
import { createCricketLogger, normalizeLogger } from '@robdel12/cricket/logger';
import { generateOpenApi } from '@robdel12/cricket/openapi';
import { defineSerializer } from '@robdel12/cricket/serializer';
import { createTestRuntime } from '@robdel12/cricket/test';
```
