# Cricket

Tiny contracts for sturdy Node APIs.

Cricket gives Node APIs the backend shape that stays pleasant as the API grows:
Zod models, pure normalizers, pure serializers, boring services, named rules,
thin routes, OpenAPI generation, and a normal Node entrypoint.

It is intentionally plain JavaScript. No model instances, no hidden mutation, no
ORM lifecycle. Your app passes POJOs around, composes functions, and keeps side
effects at the edges.

## Install

```sh
pnpm add @robdel12/cricket
```

Cricket owns the HTTP runtime. It routes requests, parses bodies, validates
contracts, runs rules, writes responses, and handles startup and shutdown.

Your app still owns its database schema, migrations, auth policy, queues,
external clients, workers, and deployment.

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
| `services/` | Shared app capabilities: email, media storage, payment clients, caches, cross-domain summaries. | Domain-specific product logic. |
| `workers/` | Background entrypoints that call services. | A second product layer. |
| `migrations/` | App-owned Knex migrations. | Hidden Cricket database behavior. |
| `dev/` | Local-only helpers, fixture builders, reset/setup scripts, smoke-test harnesses. | Production runtime or product behavior. |

If code affects product behavior, design it into a domain, app service, worker,
middleware, or migration. `dev/` is local-only.

## App Entry

Put the app contract in your normal Node entrypoint, usually `api/index.js`.

```js
import knex from 'knex';
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
  // Cricket scans this folder for standard domain files that exist.
  domains: './domains',
  async setup() {
    // Create app-wide dependencies once at startup.
    let db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL
    });

    // Return the things Cricket should pass into routes, rules, and cleanup.
    return {
      dependencies: { db },
      services: {
        mailer: createMailer(),
        sessions: createSessionService({ db })
      },
      cleanup() {
        return db.destroy();
      }
    };
  },
  use: [readSession()],
  context({ dependencies, logger, services }) {
    // Shape the per-request context your handlers and rules receive.
    return {
      ...dependencies,
      logger,
      services
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
import { created, defineEndpoint, z } from '@robdel12/cricket';
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

Handlers receive Cricket input plus the context your app returns. Knex `db`,
transactions, logger, services, auth facts, request IDs, and loaded resources
remain available when you pass them through `context(...)`, `use`, or rules.

## Observability

Cricket emits safe lifecycle events from the HTTP runtime when an app provides
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
plain lifecycle artifact, not a second logging system.

## CLI

```sh
pnpm cricket init app .
pnpm cricket new domain project api/domains
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket init agents .
```

`init app` creates the small app shell: `api/index.js`, `api/domains/`,
`api/middleware/`, `api/services/`, `api/workers/`, `api/migrations/`, and
`api/dev/`.

`new domain` creates the standard files and skips existing files unless
`--force` is passed.

`inspect` prints the loaded domains, services, routes, and models for an app
module.

`docs` writes OpenAPI from the same app module your server runs.

`init agents` writes lightweight guidance for people and agents working inside a
Cricket app.

## Exports

```js
import {
  defineCricketApp,
  startCricketApp,
  createCricketRuntime,
  defineEndpoint,
  defineModel,
  defineRule,
  defineSerializer,
  defineNormalizer,
  field,
  createKnexRepository,
  z
} from '@robdel12/cricket';
```

Public subpaths are also available:

```js
import { createKnexRepository } from '@robdel12/cricket/knex';
import { generateOpenApi } from '@robdel12/cricket/openapi';
import { defineCricketApp } from '@robdel12/cricket/app';
import { loadDomains } from '@robdel12/cricket/domain';
import { normalizeLogger } from '@robdel12/cricket/logger';
import { defineSerializer } from '@robdel12/cricket/serializer';
```
