# Cricket

Tiny contracts for sturdy Node APIs.

Cricket gives Node APIs the backend shape that stays pleasant as the API grows:
Zod models, pure normalizers, pure serializers, boring services, named rules,
thin routes, first-class jobs, OpenAPI generation, and a normal Node entrypoint.

It is intentionally plain JavaScript. No model instances, no hidden mutation, no
ORM lifecycle. Your app passes POJOs around, composes functions, and keeps side
effects at the edges.

## Install

```sh
pnpm add @robdel12/cricket
```

Cricket owns the HTTP runtime. It routes requests, parses bodies, validates
contracts, runs rules, writes responses, and handles startup and shutdown.

Your app still owns its database schema, migrations, auth policy, product
services, external clients, worker entrypoints, and deployment.

## Core Concepts

Cricket treats an API as a request-to-response transform, with side effects kept
at explicit boundaries.

```text
app
  request
    -> middleware before     HTTP edge transforms requestContext
      -> domains.routes      match endpoint or fallback
        -> validations       trusted input shape
        -> rules             request permission + loaded facts
        -> handler/services  app work + side effects
        -> serializers       API output shape
      -> response draft
    <- middleware after      response headers, cookies, logging, timing
  response

  outside-source data
    -> domains.normalizers   third-party, CSV, webhook, queue, import, legacy projections

  background work
    -> jobs                  validated immutable envelopes
      -> Redis               hot coordination
      -> services            app-owned product work
```

## Domain Shape

Use one folder per domain.

```text
api/domains/project/
  project.model.js        durable Zod contracts
  project.validations.js  request/source input contracts
  project.normalizers.js  third-party/source payload projections
  project.serializers.js  response schemas and projections
  project.service.js      data and product operations
  project.rules.js        auth, existence, ownership, business guards
  project.routes.js       endpoint contracts
  project.test.js         HTTP-boundary endpoint tests
```

The folder is the domain. Cricket auto-loads the standard files from your domain
root, then wires the files that exist. Models, validations, normalizers,
serializers, services, rules, and routes are standard homes, not mandatory
paperwork.

Extra files are fine when a domain needs them. Keep the standard files as the
map.

## App Shape

```text
api/
  index.js      app entrypoint and Cricket wiring
  domains/      product API domains
  middleware/   request middleware
  services/     app-wide services
  workers/      background workers
  migrations/   app-owned database migrations
  dev/          local-only developer support
```

| Folder | Use it for | Keep out |
| --- | --- | --- |
| `domains/` | Product API behavior. | App-wide clients and app-level middleware. |
| `middleware/` | Request middleware: auth extraction, request IDs, CORS, rate limits, raw webhooks, frontend fallbacks. | Domain authorization; put that in `*.rules.js`. |
| `services/` | Narrow shared capabilities: email, media storage, payment clients, caches, external clients. | Domain-specific product logic. |
| `workers/` | Background entrypoints that start Cricket workers. | A second product layer. |
| `migrations/` | App-owned Knex migrations for `cricket migrate`. | Product data policy or query design. |
| `dev/` | Local-only helpers, fixture builders, reset/setup scripts, smoke-test harnesses. | Production runtime or product behavior. |

If code affects product behavior, design it into a domain, app service, worker,
middleware, or migration. `dev/` is local-only.

## App Entry

Put the app contract in your normal Node entrypoint, usually `api/index.js`.

```js
import { defineCricketApp, startCricketApp } from '@robdel12/cricket';

function readSession() {
  return async (requestContext, next) => {
    let authorization = String(requestContext.request.headers.authorization ?? '');
    let user = authorization
      ? await requestContext.services.sessions.verifyBearerToken(authorization)
      : undefined;

    return await next({
      ...requestContext,
      context: {
        ...requestContext.context,
        user
      }
    });
  };
}

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
  // Cricket scans this folder for standard domain files that exist.
  domains: './domains',
  async setup({ db }) {
    return {
      services: {
        mailer: createMailer(),
        sessions: createSessionService({ db })
      }
    };
  },
  middleware: [readSession()],
  context({ request }) {
    // Add app-specific request facts. Cricket already passes dependencies,
    // lifecycle, db, logger, services, and trace through the base context.
    return {
      requestId: request.id
    };
  }
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, {
    port: process.env.PORT || 3000,
    main: import.meta.url
  });
```

## Middleware

Cricket middleware receives a plain request context and returns a response or
passes the next request context forward. Treat it as immutable: copy what you
change.

```js
export function requestId() {
  return async (requestContext, next) => {
    return await next({
      ...requestContext,
      context: {
        ...requestContext.context,
        requestId: crypto.randomUUID()
      }
    });
  };
}
```

Use middleware for cross-cutting HTTP work before Cricket parses an endpoint
body.

## Model

Models define durable row contracts, public/private visibility, and sensitive
fields.

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
  },
  views: {
    owner: ['id', 'owner_id', 'slug', 'name']
  }
});
```

Cricket derives strict Zod schemas from the row map:

```js
Project.row       // all fields
Project.public    // public fields only
Project.owner     // explicit named view
```

Use `Project.row` at the database boundary. Request and source input contracts
belong in `*.validations.js`, not as model lifecycle keys.

Visibility and sensitive handling are separate on purpose. Visibility controls
the default output contract. Fields default to `sensitive: false`; add
`sensitive: true` when a field needs careful handling in logging, inspection,
and observability work. Cricket does not define PII or internal-data categories
for you; compose those product-specific policies from this marker in app code.

## Validation

Validations are reusable Zod schemas for data entering a boundary.

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

Routes, rules, services, and normalizers import the schemas they use. Cricket
does not auto-wire validations by name.

## Normalizer

Normalizers translate outside-world payloads into app-owned shapes.

```js
import { defineNormalizer, z } from '@robdel12/cricket';
import { ProjectCreateInput } from './project.validations.js';

export let normalizeProjectImport = defineNormalizer({
  name: 'project.import',
  source: z.object({
    SLUG: z.string(),
    NAME: z.string()
  }).passthrough(),
  output: ProjectCreateInput,
  normalize(row) {
    return {
      slug: row.SLUG,
      name: row.NAME
    };
  }
});
```

Reach for `*.normalizers.js` when a third-party API, CSV, webhook, queue
payload, or legacy source speaks in its own shape. Keep normalizers pure: no
fetching, no DB writes, no auth, no queues. Cricket validates source and output
contracts when the normalizer runs.

## Serializer

Serializers are pure projections for data leaving the API.

```js
import { defineSerializer, pickFields } from '@robdel12/cricket';
import { Project } from './project.model.js';

export let serializeProjectPublic = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});
```

Use serializers to drop private fields and create endpoint-specific API shapes.
They should not query, mutate, or check permissions. Cricket validates serializer
output, so leaking a private field through `Project.public` fails.

## Service

Services do data and product work without knowing about HTTP.

```js
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './project.model.js';
import { ProjectInsert } from './project.validations.js';

export function createProjectService({ db, ids }) {
  let projects = createKnexRepository({
    db,
    model: Project,
    insert: ProjectInsert
  });

  return {
    async createForUser({ userId, slug, name }) {
      return await projects.insert({
        id: ids.next(),
        owner_id: userId,
        slug,
        name
      });
    }
  };
}
```

`createKnexRepository()` handles row parsing and small CRUD helpers. It is not an
ORM. Use raw Knex when the query is clearer.

## Database

Cricket uses Knex as the database path. Put the config on the app contract:

```js
export let app = defineCricketApp({
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
  }
});
```

Cricket creates one `db` handle for the runtime, passes it through setup,
services, rules, middleware, and handlers, then destroys it during cleanup.
The active environment comes from `database.environment`,
`CRICKET_DATABASE_ENV`, `NODE_ENV`, `database.defaultEnvironment`, then
`development`. Shared Knex options can live beside `environments`; the selected
environment overrides them.

Migrations live in `api/migrations/` by convention. Only set
`database.migrations.directory` when an app is intentionally changing that
shape.

```sh
pnpm cricket migrate make api/index.js create_projects
pnpm cricket migrate latest api/index.js
pnpm cricket migrate latest api/index.js --env production
pnpm cricket migrate status api/index.js
pnpm cricket migrate list api/index.js
pnpm cricket migrate current-version api/index.js
pnpm cricket migrate rollback api/index.js
```

Cricket does not run migrations on server start, design tables, hide data
policy, or replace Knex. It just makes the database contract and migration
commands visible from the same app definition.

## Rule

Rules answer whether the request can continue.

```js
import { defineRule, forbidden } from '@robdel12/cricket';

export let ownsProject = defineRule(
  'project.ownsProject',
  async ({ input, services, user }) => {
    let project = await services.project.findBySlug(input.params.slug);

    if (!project || project.owner_id !== user.id)
      throw forbidden('Project access denied');

    return {
      project
    };
  }
);
```

Rules are the right place for auth, ownership, existence, billing, feature
limits, and business preconditions. When a rule loads request-local facts, return
them as a plain object so the next rule and handler receive them directly.

## Route

Routes compose the HTTP contract.

```js
import {
  created,
  defineEndpoint,
  deprecateEndpoint,
  ok,
  z
} from '@robdel12/cricket';
import { Project } from './project.model.js';
import { serializeProjectPublic } from './project.serializers.js';
import { ProjectCreateInput } from './project.validations.js';
import {
  requireUser,
  slugAvailable
} from './project.rules.js';

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
    let project = await services.project.createForUser({
      userId: user.id,
      ...input.body
    });

    return created({
      success: true,
      project: serializeProjectPublic(project)
    });
  }
});

export let projectEndpoints = [
  createProject
];
```

Handlers receive Cricket input plus the request context. Setup dependencies,
lifecycle, logger, services, and trace are already there. Add app-specific facts in
`context(...)`, middleware, or rules.

## Runtime Lifecycle

Cricket exposes the HTTP runtime state it already owns through `lifecycle`.
Apps can read `lifecycle.phase()`, `lifecycle.status()`,
`lifecycle.isReady()`, `lifecycle.isShuttingDown()`, and
`lifecycle.isStopped()` from setup, services, middleware, context, handlers, and
shutdown hooks.

The lifecycle reader is immutable from app code. `status()` returns a frozen
snapshot, and Cricket keeps phase transitions private inside the runtime.

This is not a health endpoint or readiness system. Compose lifecycle state into
your own product health checks when it matters.

Deprecate an endpoint by wrapping the endpoint object. Deprecation is a signal,
not behavior control: Cricket still routes the request, validates input, runs
rules, and returns the handler response.

```js
export let checkShas = deprecateEndpoint(defineEndpoint({
  method: 'post',
  path: '/sdk/check-shas',
  response: z.object({
    success: z.literal(true)
  }),
  async handler({ input, services }) {
    return ok(await services.sdk.checkShas(input.body));
  }
}), {
  since: '2026-06-17',
  sunset: '2026-09-01',
  replacement: 'POST /sdk/screenshots/batch',
  reason: 'Use the batch screenshot upload flow instead.'
});
```

`docs` marks the operation with OpenAPI `deprecated: true` and keeps the details
under `x-cricket-deprecation`. `inspect` labels the route and prints the sunset,
replacement, and reason. Runtime observability gets the same metadata, which is
usually the useful signal for product APIs.

HTTP deprecation headers are opt-in. Use them when clients outside your product
need migration hints from the response itself.

```js
export let publicLegacyRoute = deprecateEndpoint(endpoint, {
  sunset: '2026-09-01',
  replacement: 'GET /v2/projects/:slug',
  reason: 'Use the v2 project route.',
  headers: true
});
```

When `headers` is true, Cricket adds `Deprecation`, `Sunset`, and replacement
`Link` headers when it can infer a successor path, unless your handler already
set those headers.

## Observability

Every Cricket app gets a structured logger. By default it writes
newline-delimited JSON to stdout with the app name as the service, or
`Cricket app` if unnamed. Configure `logger` when you want a different service,
level, format, or write target.

```js
export let app = defineCricketApp({
  name: 'Project API',
  logger: {
    service: 'project-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  }
});
```

The runtime passes the logger through setup, services, startup, and shutdown.
For each request, middleware, context, rules, handlers, and error handling get a
request-scoped child logger. Matched route logs also carry route identity, so
one `requestId` is enough to inspect the request flow.

Cricket also keeps sparse, monotonic timings at the HTTP boundary: middleware,
route match, validation, rules, handler, response finish, and close. They show
where a request spent time without turning logs into a firehose.

Cricket emits safe request events from the HTTP runtime when an app provides
`observability.observe`.

```js
export let app = defineCricketApp({
  observability: {
    observe(event) {
      console.log(event.type, event.requestId);
    }
  }
});
```

Events include `request.started`, `route.matched`, `request.failed`,
`response.finished`, and `response.closed`. Request snapshots include method,
path, host, protocol, and the names of headers, cookies, query keys, and params.
They do not include raw auth headers, cookie values, query values, request
bodies, response bodies, or `Set-Cookie` values.

The terminal response event includes a replay list for that request. Replay is a
plain request artifact, not a second logging system.

Cricket wraps endpoint handlers in request-scoped spans by default. The span
name comes from `operationId` when you provide one, or from the method and path
when you don't. Add `traceName` only when you want a different product name in
the logs.

```js
export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  operationId: 'projects.create',
  async handler({ input, services }) {
    return created(await services.projects.create(input.body));
  }
});
```

Cricket also passes a request-scoped `trace` capability through middleware,
context, rules, and handlers so apps can wrap deeper workflow stages with
`trace.span(name, metadata, fn)`. Spans return the callback result, rethrow the
original error, and keep metadata to safe scalar values.

Use `createCricketLogger` when you want an explicit logger value for tests,
workers, CLIs, or custom composition.

```js
import { createCricketLogger } from '@robdel12/cricket/logger';

let logger = createCricketLogger({
  service: 'api',
  write(line) {
    process.stdout.write(`${line}\n`);
  }
});
```

In production, let Docker or the host runtime store and rotate logs. When you
need one request, pipe the logs back through Cricket:

```sh
docker logs api | pnpm cricket trace req_123
```

Cricket's built-in structured logger redacts common secret-shaped keys at the
boundary and keeps child metadata, including `requestId`, in the envelope that
`cricket trace` understands. If you pass a custom logger, Cricket forwards the
same events into that logger's shape.

`trace` reads the same logs back on demand and renders request timings plus span
records. Cricket does not store that data for you.

## Jobs

Jobs are Cricket contracts for background work. Use them when work needs a
validated input shape, retry policy, queue coordination, and the same runtime
capabilities your HTTP handlers already get.

```js
import {
  createJobLedgerTable,
  createCricketJobs,
  defineJob,
  redisQueue,
  retry,
  startCricketWorker,
  state
} from '@robdel12/cricket/jobs';
import { z } from 'zod';

export let generateReport = defineJob({
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

  queue: redisQueue({
    name: 'reports',
    idempotencyKey: ({ input }) => input.reportId,
    partition: ({ input }) => `account:${input.accountId}`,
    priority: ({ context }) => context.priority
  }),

  retry: retry.exponential({
    attempts: 3,
    delayMs: 2_000,
    maxDelayMs: 60_000,
    when: ({ error }) => error.retryable !== false
  }),

  state: state.derived({
    from: ['accounts', 'reports', 'templates']
  }),

  async run({ input, services, trace, progress }) {
    await progress.update({ current: 1, total: 1 });

    return trace.span('reports.generate', {
      accountId: input.accountId
    }, () => services.reports.generate(input));
  }
});
```

Enqueueing a job creates an immutable envelope. Redis stores Cricket-owned
queue structures for hot coordination. Your app-owned records and services keep
product truth.

```js
await jobs.enqueue(generateReport, {
  reportId,
  accountId,
  templateId
}, {
  context: {
    requestId,
    source: 'report.requested',
    priority: 50
  }
});
```

Producer entrypoints can enqueue without starting a worker:

```js
let producer = await createCricketJobs({
  jobs: [generateReport],
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  }
});

await producer.jobs.enqueue(generateReport, input, {
  context: {
    requestId,
    source: 'report.requested'
  }
});
```

Worker entrypoints stay small:

```js
import { startCricketWorker } from '@robdel12/cricket/jobs';
import { app } from '../index.js';
import { generateReport } from '../domains/reports/reports.jobs.js';

await startCricketWorker(app, {
  baseUrl: new URL('../index.js', import.meta.url),
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  },
  jobs: [
    generateReport
  ]
});
```

Job `run` functions receive `services`, `logger`, `trace`, `lifecycle`, `jobs`,
and `progress`. They never receive Redis objects.

When the app has a Cricket database, workers also write a framework-owned
`cricket_jobs` ledger row for each envelope. The ledger is execution history:
status, attempts, queue metadata, request/source context, latest progress,
result or error, and timestamps. It is not product state, and Cricket does not
create the table at worker startup. Ledger write failures are logged as
`job.ledger_failed` and do not change queue execution.

Add it in a normal app migration:

```js
import { createJobLedgerTable } from '@robdel12/cricket/jobs';

export async function up(db) {
  await createJobLedgerTable(db);
}

export async function down(db) {
  await db.schema.dropTable('cricket_jobs');
}
```

## Testing

Cricket tests are normal `node:test` files. The test helpers add a real Cricket
runtime, a small HTTP client, and inspectable request state. They do not reset
your database, fake auth, bypass endpoints, or replace Node's test runner.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestRuntime } from '@robdel12/cricket/test';
import { app } from '../api/index.js';

test('creates a project through the API', async () => {
  let { api, cleanup, testState } = await createTestRuntime(app);

  try {
    let response = await api.post('/api/projects', {
      headers: {
        authorization: 'Bearer test-token'
      },
      body: {
        name: 'Launch Plan'
      }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.name, 'Launch Plan');

    let request = testState.request(response.requestId);

    assert.equal(request.response.status, 201);
    assert.equal(Number.isFinite(request.timings.totalMs), true);
    assert.equal(Number.isFinite(request.timings.handlerMs), true);
  } finally {
    await cleanup();
  }
});
```

`createTestRuntime(app)` returns `{ api, runtime, testState, cleanup }`.

`api` talks to a real local HTTP server on an ephemeral port. It has `get`,
`post`, `put`, `patch`, `delete`, `head`, `options`, and `request` helpers.
Request options are `{ headers, query, body, text, buffer, formData, redirect }`,
and responses have `{ status, headers, body, text, requestId }`. JSON responses
are parsed into `body`; non-JSON responses keep their bytes in `body` as a
`Buffer` while also exposing `text`.

`testState` exposes safe frozen data from Cricket's runtime:

- `report()` returns the current report object.
- `events(filter?)` returns lifecycle events.
- `logs(filter?)` returns structured log records.
- `requests(filter?)` returns terminal request records.
- `request(requestId)` returns one request with route, request, response,
  timings, and replay.
- `trace(requestId)` returns the request's events, logs, spans, and timings.
- `jobs(filter?)` returns job runtime events.
- `job(jobRunId)` returns one job run with events, logs, and spans.
- `clear()` clears only the collector. It does not touch app state.

Timings are facts, not budgets. Use them when a test needs to prove a workflow
used the expected lifecycle path, or when you want to assert that a timing field
exists for later debugging. Cricket does not decide that your app is "too slow."

The CLI wraps Node's runner with Cricket defaults:

```sh
pnpm cricket test
pnpm cricket test test/projects.test.js --grep "creates a project"
pnpm cricket test --json
pnpm cricket test --output cricket-test-report.json
```

By default, `cricket test` discovers `api/**/*.test.js`, `src/**/*.test.js`, and
`test/**/*.test.js`, then runs `node --test`. Use `--reporter cricket|spec|dot|tap`
for human output, `--coverage` for Node's test coverage, `--concurrency <number>`
for suites that need serial or bounded execution, `--json` for a Node test
summary on stdout, and `--output <path>` to write that summary while still
printing human output.

## CLI

```sh
pnpm cricket init app .
pnpm cricket new domain project api/domains
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate latest api/index.js
pnpm cricket test
pnpm cricket init agents .
```

`init app` creates the small app shell: `api/index.js`, `api/domains/`,
`api/middleware/`, `api/services/`, `api/workers/`, `api/migrations/`, and
`api/dev/`.

`new domain` creates the standard files and skips existing files unless
`--force` is passed.

`inspect` prints the loaded domains, model sensitive-field markers, rules,
services, jobs, route operation IDs, and observability posture for an app
module.

`docs` writes OpenAPI from the same app module your server runs.

`migrate` runs Knex migrations from the app's `database` contract. The default
directory is `api/migrations/`; pass `--env name` to run against a specific
database environment.

`trace` reads newline-delimited JSON logs from stdin and prints a
human-readable request timeline for one `requestId`, including request timings
and any recorded spans.

`test` runs Node's built-in test runner with Cricket's file discovery and
optional JSON report output.

`init agents` writes lightweight guidance for people and agents working inside a
Cricket app. It augments `AGENTS.md` and installs the repo-local skill at
`.agents/skills/cricket-api/SKILL.md`.

## Exports

```js
import {
  defineCricketApp,
  startCricketApp,
  createCricketRuntime,
  defineJob,
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
  createCricketJobs,
  createJobLedgerTable,
  redisQueue,
  retry,
  startCricketWorker,
  state
} from '@robdel12/cricket/jobs';
```

Public subpaths are also available:

```js
import { createKnexRepository } from '@robdel12/cricket/knex';
import { generateOpenApi } from '@robdel12/cricket/openapi';
import { defineCricketApp } from '@robdel12/cricket/app';
import { loadDomains } from '@robdel12/cricket/domain';
import { createCricketLogger, normalizeLogger } from '@robdel12/cricket/logger';
import { defineSerializer } from '@robdel12/cricket/serializer';
import { createTestRuntime } from '@robdel12/cricket/test';
```
