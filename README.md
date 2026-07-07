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

Start by scaffolding the app shape and the agent guidance:

```sh
pnpm cricket init app .
pnpm cricket init agents .
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
```

`init app` creates the folders Cricket expects. `init agents` adds an
`AGENTS.md` section and a small local skill suite under `.agents/skills/`:

- `cricket` teaches the framework shape, domain pattern, and change flow.
- `cricket-jobs` teaches jobs, schedules, retries, workers, and the ledger.
- `cricket-observability` teaches logging, tracing, lifecycle, and debugging.
- `cricket-testing` teaches HTTP-boundary tests, worker-boundary job tests, and
  Cricket test state.

That skill suite is part of Cricket's docs surface. It exists because Cricket is
meant to be easy for agents to use correctly while humans drive the product
decisions.

In this repo, the canonical scaffolded guidance lives in
`src/templates/agents/`, including each skill's real `SKILL.md` file.

## Principles

- Keep data plain: objects in, objects out.
- Keep side effects at clear boundaries: services, handlers, jobs, middleware,
  migrations, and external clients.
- Keep contracts at real edges: requests, responses, source payloads, jobs, and
  database rows.
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

## Domain Shape

Use one folder per domain.

```text
api/domains/project/
  project.model.js        row contracts and visibility
  project.validations.js  request/source/service input schemas
  project.normalizers.js  outside payload projections
  project.serializers.js  API output projections
  project.service.js      data and product operations
  project.rules.js        auth, existence, ownership, business guards
  project.routes.js       endpoint contracts
  project.jobs.js         background job contracts
  project.test.js         HTTP and worker-boundary tests
```

The folder is the domain. Cricket auto-loads the standard files that exist.
Optional files stay optional, but standard names should stay predictable.

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

`setup` returns app capabilities. Cricket passes `services`, `db`, `logger`,
`trace`, and `lifecycle` through middleware, context, rules, handlers, jobs,
workers, startup, shutdown, and tests.

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
import { Project } from './project.model.js';

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
import { Project } from './project.model.js';
import { ProjectInsert } from './project.validations.js';

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
import { Project } from './project.model.js';
import { serializeProjectPublic } from './project.serializers.js';
import { ProjectCreateInput } from './project.validations.js';
import { requireUser, slugAvailable } from './project.rules.js';

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
validated input, immutable envelopes, Redis coordination, scheduled execution,
recovery, failure handling, logs, traces, progress, and the same services your
HTTP handlers use.

```js
import { z } from '@robdel12/cricket';
import {
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
  queue: redisQueue({
    name: 'reports',
    idempotencyKey: ({ input }) => input.reportId,
    partition: ({ input }) => `account:${input.accountId}`
  }),
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
import { generateReport } from '../domains/reports/reports.jobs.js';

let worker = await startCricketWorker(app, {
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  },
  jobs: [generateReport]
});

await worker.run();
```

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

Recovery is app-owned. Cricket keeps the worker heartbeat fresh and records the
job's normal logs, spans, progress, ledger row, and run state. Your `recover`
function reads those facts and returns a plain decision:

```js
return { action: 'continue' };
return { action: 'retry', reason: { code: 'worker_lost' } };
return { action: 'fail', reason: { code: 'outside_business_window' } };
```

Use logs for domain breadcrumbs, `trace.span()` for timed work, and
`progress.update()` for human-readable progress. Cricket does not define
"stuck" for you. The job does.

## Observability

Cricket provides one logger shape, request/job events, sparse timings, trace
spans, and lifecycle state.

```js
export let app = defineCricketApp({
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
jobs, workers, and shutdown hooks. Product health checks still decide whether
the app is ready for traffic.

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

`testState` exposes events, logs, request traces, job traces, timings, and
runtime reports. It does not reset app state for you.

## CLI

```sh
pnpm cricket init app .
pnpm cricket init agents .
pnpm cricket new domain project api/domains
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate latest api/index.js
pnpm cricket test
```

`inspect` prints loaded domains, model visibility, rules, services, jobs, route
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
