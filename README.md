# Cricket

Tiny contracts for sturdy Node APIs.

Cricket gives Koa + Knex apps the backend shape that stays pleasant as the API
grows: Zod models, pure serializers, boring services, named rules, thin routes,
OpenAPI generation, and one app entrypoint.

It is intentionally plain JavaScript. No model instances, no hidden mutation, no
ORM lifecycle. Your app passes POJOs around, composes functions, and keeps side
effects at the edges.

## Install

```sh
pnpm add @robdel12/cricket
```

Cricket includes first-class Koa and Knex adapters. Your app still owns its
database schema, migrations, auth middleware, queues, external clients, and
deployment.

## Domain Shape

Use one folder per domain.

```text
project/
  project.model.js        durable Zod contracts
  project.serializers.js  response schemas and projections
  project.service.js      data and product operations
  project.rules.js        auth, existence, ownership, business guards
  project.routes.js       endpoint contracts
```

The folder is the domain. Cricket auto-loads the standard files from your domain
root, then wires models, services, rules, routes, docs, and runtime behavior from
that structure.

Extra files are fine when a domain needs them. Keep the standard files as the
map.

## App Entry

```js
import knex from 'knex';
import { defineCricketApp, startCricketApp } from '@robdel12/cricket';

export let app = defineCricketApp({
  name: 'Project API',
  version: '1.0.0',
  prefix: '/api',
  domains: './api',
  async setup() {
    let db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL
    });

    return {
      dependencies: { db },
      services: {
        mailer: createMailer()
      },
      cleanup() {
        return db.destroy();
      }
    };
  },
  context({ ctx, dependencies, logger, services }) {
    return {
      ...dependencies,
      logger,
      services,
      user: ctx.state.user
    };
  }
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, { port: process.env.PORT || 3000 });
```

OpenAPI is served at `/openapi.json` by default.

## Model

Models define durable contracts and reusable schemas.

```js
import { z } from 'zod';
import { defineModel } from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: z.object({
    id: z.uuid(),
    owner_id: z.uuid(),
    slug: z.string(),
    name: z.string()
  }),
  create: z.object({
    slug: z.string().min(3),
    name: z.string().min(1)
  })
});
```

Use `row` at the database boundary and `create` / `update` at the request
boundary. Domains that do not own persisted rows can still keep shared Zod
schemas in `*.model.js`.

## Serializer

Serializers are pure projections for data leaving the API.

```js
import { z } from 'zod';
import { camelCaseKeys, pickFields } from '@robdel12/cricket';

export let ProjectPublic = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  slug: z.string(),
  name: z.string()
});

export let serializeProjectPublic = camelCaseKeys(
  pickFields(['id', 'owner_id', 'slug', 'name'])
);
```

Use serializers to drop private fields, rename keys, and create endpoint-specific
API shapes. They should not query, mutate, or check permissions.

## Service

Services do data and product work without knowing about HTTP.

```js
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './project.model.js';

export function createProjectService({ db, ids }) {
  let projects = createKnexRepository({
    db,
    model: Project,
    insert: Project.row
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

export let ownsProject = defineRule({
  name: 'project.ownsProject',
  async check({ input, services, user, state }) {
    let project = await services.project.findBySlug(input.params.slug);

    if (!project || project.owner_id !== user.id)
      throw forbidden('Project access denied');

    state.project = project;
  }
});
```

Rules are the right place for auth, ownership, existence, billing, feature
limits, and business preconditions. They may load request-scoped `state` for the
handler.

## Route

Routes compose the HTTP contract.

```js
import { z } from 'zod';
import { created, defineEndpoint } from '@robdel12/cricket';
import { Project } from './project.model.js';
import { ProjectPublic, serializeProjectPublic } from './project.serializers.js';
import { slugAvailable } from './project.rules.js';

export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  auth: true,
  body: Project.create,
  rules: [slugAvailable],
  response: z.object({
    success: z.literal(true),
    project: ProjectPublic
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

Handlers receive Cricket input plus the adapter context your app returns. Koa
`ctx`, Knex `db`, transactions, logger, services, and other dependencies remain
available when you pass them through `context(...)`.

## CLI

```sh
cricket new domain project src/api
cricket inspect src/app.js
cricket docs src/app.js --out openapi.json
cricket init agents .
```

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
  defineEndpoint,
  defineModel,
  defineRule,
  createKnexRepository
} from '@robdel12/cricket';
```

Public subpaths are also available:

```js
import { createKoaApp } from '@robdel12/cricket/koa';
import { createKnexRepository } from '@robdel12/cricket/knex';
import { generateOpenApi } from '@robdel12/cricket/openapi';
```
