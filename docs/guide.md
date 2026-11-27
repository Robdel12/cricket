<!-- Generated from source JSDoc. Run pnpm --filter cricket-docs generate --write-markdown. -->
# Using Cricket

Cricket is a Node API framework where the code is the documentation. Every route says what it takes and what it returns, Cricket checks both, and your app's folders tell you where everything lives.

It ships its own HTTP runtime, plus logging, tracing, jobs, state machines, migrations, and a test harness. There's no ORM, no classes to extend, and no magic wiring.

## What you get

- **Self-documenting.** Contracts aren't comments. Cricket checks them on every request and turns them into OpenAPI, `cricket inspect` output, and agent guidance, so the docs can't drift from the code.
- **Domain-first.** Each feature lives in one folder, and each file in it has one job. You'll know where code lives before you open anything.
- **Functional and immutable.** Plain functions, plain objects, and definitions that are frozen once they're built. Compose them however you like.
- **Built for agents.** Predictable files and explicit dependencies make Cricket apps safe to change, whether the next commit comes from you or a coding agent. `cricket init` writes the guidance for them.

## Where to start

New here? You can [get a route running](guide.md#your-first-route) in a few minutes. Once you want more than one file, [organize your app](guide.md#organize-your-app) into domains. Curious why Cricket works this way? Read [the vision](../vision.md).

## Your first route

Let's get a route running. You'll need Node 24 or newer and pnpm. In a few minutes you'll have a real endpoint that checks what comes in and what goes out.

### Install Cricket

Run this in an empty folder. Already have a `package.json`? Skip `pnpm init` and set `"type": "module"` in it.

```sh
pnpm init --init-type module
pnpm add github:Robdel12/cricket
```

### Add a route

Save this as `api.js`.

```js title="api.js"
import {
  defineCricketApp,
  defineEndpoint,
  startCricketApp,
  z
} from '@robdel12/cricket';

let hello = defineEndpoint({
  method: 'get',
  path: '/hello/:name',
  params: z.object({ name: z.string().min(1) }),
  response: z.object({ message: z.string() }),
  handler({ input }) {
    return { message: `Hey, ${input.params.name}!` };
  }
});

export let app = defineCricketApp({
  name: 'Hello API',
  domains: [{ name: 'hello', endpoints: [hello] }]
});

await startCricketApp(app, { port: 3000, main: import.meta.url });
```

`defineEndpoint` is the contract. It says this route takes a `name` param and returns a `message`. Cricket checks both sides, so the handler only ever sees good input.

### Try it

Start the server.

```sh
node api.js
```

Then hit it from a second terminal.

```sh
curl http://localhost:3000/hello/Cricket
```

You should see `{"message":"Hey, Cricket!"}`. That's it, you've got a Cricket API!

The `main: import.meta.url` option means the server only starts when you run this file directly. Tests and CLI commands can import `app` without opening a port.

### Next up

One file gets crowded fast. [Organize your app](guide.md#organize-your-app) into domains, then [write a test](guide.md#test-your-api) for your route.

## Organize your app

Cricket apps share one layout. Once you've seen one, you can find your way around any of them, and so can your coding agent.

### Set up the folders

Run `init` in your project.

```sh
pnpm exec cricket init .
```

You'll get this layout:

```text
api/
  index.js       your app definition
  domains/       features, one folder each
  middleware/    request middleware, like reading the signed-in user
  services/      shared helpers, like email or storage clients
  workers/       background job entrypoints
  migrations/    database changes
  dev/           local-only tools
```

`init` adds a short Cricket block to `AGENTS.md`. It maps the domain files and links to local skills for domains, jobs, machines, observability, and testing.

In an existing app, run `pnpm exec cricket init agents .` to add missing guidance. After upgrading Cricket, use `pnpm exec cricket init agents . --force` to refresh it. This replaces edits to the Cricket block and shipped skill files. Your other project notes stay in place.

### Add a domain

A domain is a folder of files that change together. Here's the projects domain from the [example app](../examples/projects/):

```text
api/domains/projects/
  schema.model.js         what a stored project looks like
  input.validations.js    what callers can send
  output.serializers.js   what the API sends back
  domain.service.js       reads and writes
  access.rules.js         who can do what
  http.routes.js          the endpoints
  behavior.test.js        tests through HTTP
```

Each file has one job, and the suffix says what it is. Cricket loads files by suffix, so there's nothing to register. Start small and add files when the feature needs them. A domain can also have `*.normalizers.js` for outside data, `*.machine.js` for state, and `*.jobs.js` for background work.

Let the CLI make the files for you:

```sh
pnpm exec cricket new domain projects api/domains --with model,validations,serializers,service,rules,routes,test
```

### Point the app at your domains

The app definition lives in `api/index.js`. Set `baseUrl` so relative paths like `./domains` and `./migrations` work no matter where you run from.

```js title="api/index.js"
import { defineCricketApp, startCricketApp } from '@robdel12/cricket';
import { readUser } from './middleware/read-user.js';

export let app = defineCricketApp({
  name: 'Projects API',
  version: '1.0.0',
  baseUrl: import.meta.url,
  prefix: '/api',
  logger: {
    service: 'projects-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  },
  database: {
    client: 'sqlite3',
    useNullAsDefault: true,
    environments: {
      development: { connection: { filename: './projects.sqlite' } },
      test: { connection: { filename: ':memory:' } }
    }
  },
  domains: './domains',
  middleware: [readUser]
});

await startCricketApp(app, {
  port: process.env.PORT ?? 3000,
  main: import.meta.url
});
```

Services are named after the domain folder. The `projects` folder exports `createProjectsService`, and handlers get it as `services.projects`.

### Check your work

```sh
pnpm exec cricket check api/index.js
pnpm exec cricket inspect api/index.js
```

`check` catches structure problems, like two domains with the same name. `inspect` shows everything Cricket loaded: domains, routes, rules, services, models, jobs, and machines.

### Moving an existing app over

Got endpoints that don't fit in domains yet? Set `architecture: 'manual'` and pass `endpoints` directly while you migrate. `check` and `inspect` flag it as migration debt, and you can't mix it with `domains`, so the switch is one clean step when you're ready.

## Define route contracts

A route in Cricket is a contract. It says what the route accepts, what it checks, and what it returns. Let's walk through the projects domain from the [example app](../examples/projects/) one file at a time.

### Describe the input

Put request schemas in `*.validations.js`. They're plain Zod, so you can reuse them in routes, jobs, and services.

```js title="api/domains/projects/input.validations.js"
import { z } from '@robdel12/cricket';

export let ProjectParams = z.object({
  slug: z.string().min(3)
});

export let CreateProjectBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  name: z.string().min(1).max(100)
});
```

### Describe what you store

A model describes a database row. Mark each field `public` or `private` to say whether it can leave your app.

```js title="api/domains/projects/schema.model.js"
import { defineModel, field, z } from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'projects',
  row: {
    id: field.public(z.uuid()),
    owner_id: field.private(z.string(), { sensitive: true }),
    slug: field.public(z.string()),
    name: field.public(z.string())
  }
});
```

`Project.public` is a schema with only the public fields, which comes in handy for responses. Every field also says whether it's `sensitive`, like tokens or personal data. `cricket inspect` shows both, so you can review what a model exposes at a glance.

### Shape the output

A serializer turns your data into what the API sends back. `defineSerializer` checks its own output, so a private field can't sneak into a response.

```js title="api/domains/projects/output.serializers.js"
import { defineSerializer, pickFields } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export let serializeProject = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});
```

Pulling data in from a webhook, CSV, or another API? Use `defineNormalizer` to turn it into your app's shape. Normalizers and serializers are pure functions. They don't fetch, write, or know about HTTP.

### Do the work in a service

Services hold your reads and writes. They don't know about HTTP, so a route and a background job can call the same code.

```js title="api/domains/projects/domain.service.js"
import { randomUUID } from 'node:crypto';
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export function createProjectsService({ db }) {
  let projects = createKnexRepository({ db, model: Project, insert: Project.row });

  return {
    findBySlug(slug) {
      return projects.findOne({ slug });
    },

    create({ ownerId, slug, name }) {
      return projects.insert({ id: randomUUID(), owner_id: ownerId, slug, name });
    }
  };
}
```

`createKnexRepository` covers the simple table operations. Reach for Knex directly when a query needs more. See [Connect a database](guide.md#connect-a-database).

### Guard the route with rules

A rule decides whether a request can keep going. Return an error like `unauthenticated()` or `notFound()` to stop it. Return an object to hand facts to the next rule and the handler.

```js title="api/domains/projects/access.rules.js"
import { badRequest, defineRule, forbidden, notFound, unauthenticated } from '@robdel12/cricket';

export let requireUser = defineRule('requireUser', ({ user }) => {
  if (!user) return unauthenticated();
});

// Rules can return facts. The handler gets `project` without loading it again.
export let ownProject = defineRule('ownProject', async ({ input, services, user }) => {
  let project = await services.projects.findBySlug(input.params.slug);

  if (!project) return notFound('Project not found');
  if (project.owner_id !== user.id) return forbidden();

  return { project };
});

export let slugAvailable = defineRule('slugAvailable', async ({ input, services }) => {
  if (await services.projects.findBySlug(input.body.slug))
    return badRequest('That slug is taken');
});
```

Use rules for sign-in, ownership, existence, and business checks. Keeping them named and separate means you can read a route's access policy at a glance.

### Put it together in a route

Routes stay thin. They connect the schemas, rules, service, and serializer.

```js title="api/domains/projects/http.routes.js"
import { created, defineEndpoint, z } from '@robdel12/cricket';
import { CreateProjectBody, ProjectParams } from './input.validations.js';
import { ownProject, requireUser, slugAvailable } from './access.rules.js';
import { Project } from './schema.model.js';
import { serializeProject } from './output.serializers.js';

let ProjectResponse = z.object({ project: Project.public });

export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  body: CreateProjectBody,
  rules: [requireUser, slugAvailable],
  response: ProjectResponse,
  async handler({ input, services, user }) {
    let project = await services.projects.create({ ownerId: user.id, ...input.body });
    return created({ project: serializeProject(project) });
  }
});

export let readProject = defineEndpoint({
  method: 'get',
  path: '/projects/:slug',
  params: ProjectParams,
  rules: [requireUser, ownProject],
  response: ProjectResponse,
  handler({ project }) {
    return { project: serializeProject(project) };
  }
});
```

Here's what happens on each request:

1. Cricket parses `params`, `query`, `headers`, and `body`. Bad input gets a 422 with the Zod issues.
2. Rules run in order. The first one to return an error ends the request.
3. The handler runs with the parsed `input`, your `services`, and any facts the rules returned.
4. Cricket parses the response against `response` before sending it. If it doesn't match, the client gets a 500 and you get a log entry, so bad data never leaves your app.

Cricket also rejects unknown options when you define a route, so a typo fails right away instead of quietly doing nothing.

### Errors

Return or throw Cricket's error helpers to send a specific status:

| Helper | Status |
| --- | --- |
| `badRequest()` | 400 |
| `unauthenticated()` | 401 |
| `forbidden()` | 403 |
| `notFound()` | 404 |

Each takes an optional message and details. Every error uses the same body shape: `{ "error": { "code", "message" } }`. A plain `Error` becomes a 500 with nothing private in the body.

## Send responses

Most handlers just return the body. Cricket sends it as JSON with a 200 (or 201 for `created`). When you need control over the status, headers, or cookies, wrap the body with a response helper.

### Pick a status

```js
import { created, ok, redirect, respond } from '@robdel12/cricket';

return { project };                    // 200
return ok({ project });                // 200, spelled out
return created({ project });           // 201
return respond(202, { queued: true }); // any status
return redirect('/projects', 303);     // a redirect
```

Only these helpers can change the status. A plain object with a `status` or `redirect` field is just a body, so your data can't accidentally turn into transport instructions.

### Add headers and cookies

```js
import { ok, respond, withCookies, withHeaders } from '@robdel12/cricket';

return withHeaders(respond(202, { queued: true }), { 'Retry-After': '5' });

return withCookies(ok({ signedIn: true }), [{
  name: 'session',
  value: session.id,
  options: { httpOnly: true, secure: true }
}]);
```

### Describe more than one status

Use `responses` when a route can answer with different shapes. `response` is shorthand for the default success status.

```js
let readReport = defineEndpoint({
  method: 'get',
  path: '/reports/:id',
  responses: {
    200: z.object({ report: Report.public }),
    202: z.object({ status: z.literal('rendering') })
  },
  handler: ({ report }) => report.ready
    ? { report: serializeReport(report) }
    : respond(202, { status: 'rendering' })
});
```

Every response gets checked against its status. If the body doesn't match, the client gets a 500 and your logs get the details.

### Report an error you handled

Sometimes you catch an error and send a friendly response instead. Attach the original with `withError` so your error reporting still sees it.

```js title="examples/error-reporting.js"
import {
  defineCricketApp,
  defineEndpoint,
  respond,
  startCricketApp,
  withError,
  z
} from '@robdel12/cricket';

export let app = defineCricketApp({
  name: 'Error reporting example',
  domains: [{
    name: 'provider',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/provider',
      operationId: 'provider.read',
      responses: { 503: z.object({ error: z.string() }) },
      handler() {
        let error = new Error('Example provider is offline');
        return withError(respond(503, { error: 'Try again later' }), error);
      }
    })]
  }],
  onError(error, { logger, request, response, route, handled }) {
    // Using Sentry? Swap this for sentryErrorHandler(Sentry).
    logger.error('provider.failure', {
      name: error.name,
      requestId: request?.id,
      operation: route?.operationId,
      status: response?.status,
      handled
    });
  }
});

await startCricketApp(app, { main: import.meta.url, port: process.env.PORT || 3000 });
```

The body stays friendly, and `onError` gets the real exception. See [Follow a request](guide.md#follow-a-request) for reporting.

### Stream a file

Return a Node stream and clean it up with `withResponseCleanup`. Set `Content-Length` when you know the size, and Cricket checks the stream actually sends that many bytes.

```js title="examples/known-length-stream.js"
import { Readable } from 'node:stream';
import {
  defineCricketApp,
  defineEndpoint,
  ok,
  startCricketApp,
  withHeaders,
  withResponseCleanup,
  z
} from '@robdel12/cricket';

let content = Buffer.from('A file served through Cricket.\n');
export let app = defineCricketApp({
  name: 'Known-length stream example',
  domains: [{
    name: 'files',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/download',
      query: z.object({ format: z.enum(['text', 'binary']).default('binary') }),
      responses: {
        200: {
          schema: z.instanceof(Readable).meta({ jsonSchema: { type: 'string', format: 'binary' } }),
          contentTypes: ['text/plain', 'application/octet-stream']
        }
      },
      handler({ input }) {
        let stream = Readable.from([content]);
        return withResponseCleanup(withHeaders(ok(stream), {
          'Content-Type': input.query.format === 'text' ? 'text/plain' : 'application/octet-stream',
          'Content-Length': String(content.length),
          'Content-Disposition': 'attachment; filename="example.txt"'
        }), () => stream.destroy());
      }
    })]
  }]
});

await startCricketApp(app, { main: import.meta.url, port: process.env.PORT || 3000 });
```

Cricket handles backpressure, and it runs your cleanup even if the client disconnects halfway.

## Serve HTTP

Cricket ships its own HTTP runtime, so there's no Express or Koa to configure. Export your app from `api/index.js` and start it with `startCricketApp`.

```js
await startCricketApp(app, {
  port: process.env.PORT ?? 3000,
  main: import.meta.url
});
```

`main: import.meta.url` starts the server only when you run that file directly. Tests and CLI commands import `app` without opening a port. Once it's listening, the result includes `origin` with the real address, handy when you pass `port: 0`.

### Set things up once

`setup` runs when the runtime starts. Use it for clients you want to share, and return a `cleanup` to close them.

```js
export let app = defineCricketApp({
  baseUrl: import.meta.url,
  domains: './domains',
  async setup({ db, logger }) {
    let mailer = createMailer(process.env.SMTP_URL);

    return {
      dependencies: { mailer },
      cleanup: () => mailer.close()
    };
  }
});
```

Domain services get `dependencies` when they're created, so `createProjectsService({ db, mailer })` just works. Setup doesn't run when the CLI imports your app, so `inspect` and `docs` never connect to anything.

### Add middleware

Middleware wraps every request. It gets the request context and a `next` function. Here's the one from the [example app](../examples/projects/):

```js title="api/middleware/read-user.js"
// A stand-in for real auth. It trusts the bearer token as the user ID,
// which is fine for an example and never fine in production.
export async function readUser(requestContext, next) {
  let header = String(requestContext.request.headers.authorization ?? '');
  let token = header.replace(/^Bearer\s+/i, '');

  return await next({
    ...requestContext,
    context: {
      ...requestContext.context,
      user: token ? { id: token } : undefined
    }
  });
}
```

Use middleware for edge work like reading credentials, CORS, and request IDs. Product decisions belong in [rules](guide.md#define-route-contracts).

### Shared headers and early answers

`responseHeaders` adds default headers to every response. `requestPolicy` can answer a request before middleware runs, which is great for CORS preflight. Return nothing to carry on.

```js
let trustedOrigins = new Set(['https://console.example.com']);

export let app = defineCricketApp({
  domains: './domains',
  responseHeaders() {
    return { 'X-Content-Type-Options': 'nosniff' };
  },
  requestPolicy({ request }) {
    let origin = request.headers.origin;
    if (request.method === 'OPTIONS' && trustedOrigins.has(origin))
      return withHeaders(respond(204), {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin'
      });
  }
});
```

Headers you set on a response win over these defaults.

### Accept uploads

Turn on `multipart` and set limits that fit the upload. Files stream to temp files and show up as `request.files`. Cricket deletes them once your handler finishes.

```js
let upload = defineEndpoint({
  method: 'post',
  path: '/uploads',
  beforeBodyRules: [requireUser],
  multipart: {
    maxBytes: 50 * 1024 * 1024,
    maxFiles: 10,
    maxFileBytes: 50 * 1024 * 1024,
    maxFields: 50
  },
  handler({ request }) {
    return created({
      files: request.files.map(file => ({ name: file.originalName, size: file.size }))
    });
  }
});
```

`beforeBodyRules` run before Cricket reads the body. Return a Cricket response from a rule to end the request without reading the body first. When a limit comes from config, set it on the app with `requestBodyLimits`, keyed by the route's operation ID. Need the exact bytes, like for webhook signatures? Use `rawBody` instead.

### Use a Fetch handler

Got a library that already speaks web-standard `Request` and `Response`? Give the route a `fetch` function. Cricket still matches the route and runs rules, then hands you a real `Request`.

```js title="examples/fetch-endpoint.js"
import { defineCricketApp, defineEndpoint } from '@robdel12/cricket';

let events = defineEndpoint({
  method: 'get',
  path: '/events',
  fetchResponses: {
    200: {
      description: 'Server-sent events',
      contentTypes: ['text/event-stream']
    }
  },
  fetch(request, { request: cricketRequest }) {
    let body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: connected\ndata: ${cricketRequest.id}\n\n`));
        controller.close();
      }
    });

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' }
    });
  }
});

export let app = defineCricketApp({
  name: 'Fetch endpoint example',
  domains: [{ name: 'events', endpoints: [events] }]
});
```

Fetch routes declare their statuses and content types in `fetchResponses`. Cricket checks those without buffering the body. Use a normal handler for parsed bodies, raw bodies, multipart uploads, and endpoint API versions.

### Run behind a proxy

Cricket ignores `X-Forwarded-*` headers by default. If a proxy you control sits in front of the app, list its addresses.

```js title="examples/trusted-proxy.js"
import { defineCricketApp, defineEndpoint, ok, startCricketApp } from '@robdel12/cricket';

// This trusts a proxy on the same machine. Swap in your real proxy addresses,
// and have the proxy overwrite forwarded headers. Being on a private network
// isn't enough to trust a caller.
export let app = defineCricketApp({
  name: 'Trusted proxy example',
  trustProxy: { peers: ['127.0.0.1', '::1'] },
  allowedHosts: ['api.example.test'],
  domains: [{
    name: 'connection',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/connection',
      handler({ request }) {
        return ok({
          origin: request.origin,
          secure: request.secure,
          proxyTrusted: request.proxyTrusted
        });
      }
    })]
  }]
});

await startCricketApp(app, { port: 4020, main: import.meta.url });
```

Only listed peers can set the client IP, host, or protocol. Use your real proxy addresses, and have the proxy overwrite forwarded headers rather than pass them through.

### Shut down cleanly

Call `stop(signal)` on the started server. Cricket stops taking new requests, runs your `onShutdown` hook, waits for in-flight requests and streams to finish, then runs `cleanup` and closes the database.

Need to pause traffic for a moment, like while you reset state? `runtime.requests.pause()` holds new requests with a 503 until you resume.

```js title="examples/request-pause.js"
import { defineCricketApp, defineEndpoint } from '@robdel12/cricket';
import { createTestRuntime } from '@robdel12/cricket/test';

let state = { message: 'Before maintenance' };
let app = defineCricketApp({
  domains: [{
    name: 'message',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/message',
      handler: () => state
    })]
  }],
  logger() {}
});
let harness = await createTestRuntime(app);

try {
  let hold = harness.runtime.requests.pause();
  await hold.idle();
  state = { message: 'After maintenance' };
  hold.resume();

  console.log(harness.origin, (await harness.api.get('/message')).body);
} finally {
  await harness.cleanup();
}
```

## Connect a database

Cricket uses [Knex](https://knexjs.org) for databases. Add a `database` config to your app and Cricket opens the connection, hands `db` to your services, and closes it on shutdown.

### Configure it

Install the driver for your database, like `pg` or `sqlite3`. Then describe each environment once:

```js
export let app = defineCricketApp({
  baseUrl: import.meta.url,
  domains: './domains',
  database: {
    client: 'pg',
    environments: {
      development: { connection: process.env.DATABASE_URL },
      test: { client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true },
      production: { connection: process.env.DATABASE_URL }
    }
  }
});
```

Cricket picks the environment from `CRICKET_DATABASE_ENV`, then `NODE_ENV`, then `defaultEnvironment`, and falls back to `development`. `cricket test` sets `NODE_ENV=test` for you.

### Write migrations

Migrations live in `api/migrations/`. Make one with the CLI:

```sh
pnpm exec cricket migrate make api/index.js create_projects
```

Each one is a plain Knex migration:

```js title="api/migrations/20260101000000_create_projects.js"
export async function up(db) {
  await db.schema.createTable('projects', table => {
    table.string('id').primary();
    table.string('owner_id').notNullable();
    table.string('slug').notNullable().unique();
    table.string('name').notNullable();
  });
}

export async function down(db) {
  await db.schema.dropTable('projects');
}
```

Then run them:

```sh
pnpm exec cricket migrate latest api/index.js
pnpm exec cricket migrate status api/index.js
pnpm exec cricket migrate rollback api/index.js
```

Cricket never runs migrations when the server starts. Run them as their own deploy step, so a bad migration can't take down a starting server.

### Query from a service

`createKnexRepository` gives a service the common table operations, and it parses rows against your model.

```js
let projects = createKnexRepository({ db, model: Project, insert: Project.row });

await projects.insert({ id, owner_id, slug, name });
await projects.findOne({ slug });
```

You get `findOne`, `list`, `insert`, `updateById`, and `deleteById`.

When you need joins, transactions, or anything fancier, use `db` directly. It's just Knex. Cricket isn't an ORM, and it doesn't hide your queries.

## Version your API

Clients don't all update at once. API versions let old clients keep working while your routes move forward, without copying every route.

The idea is simple: each route has one current contract. Older versions only describe the differences, as a normalizer for old request bodies and a serializer for old responses.

### Define a version family

A family names the header clients send, the current version, and the default for clients that send nothing.

```js
import { defineApiVersions } from '@robdel12/cricket';

export let sdkVersions = defineApiVersions({
  name: 'sessions.sdk',
  header: 'Sessions-Version',
  current: '2026-09-01',
  default: '2025-11-15',
  versions: {
    '2025-11-15': { deprecatedAt: '2026-09-01', sunsetAt: '2027-09-01' },
    '2026-09-01': {}
  }
});
```

### Opt a route in

Here the old API sent `duration_seconds`, and the current one uses `durationMinutes`:

```js title="examples/versioned-api.js"
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
  // Reusing the route's body schema means old requests get the same checks.
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
  // By now the value already passed the current response schema.
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
```

Old requests run through the normalizer, then get checked against the current `body` schema. The handler only ever sees the current shape. On the way out, Cricket checks the current response first, then runs the old serializer.

Routes without `apiVersions` ignore the version header completely. To negotiate a version on a route that hasn't changed, use `apiVersions: sdkVersions()`.

### What clients see

Cricket echoes the selected version in a response header and adds `Vary`. A version it doesn't know gets a 400. Rules and handlers get `apiVersion` in case they need to load different data, but services never see it.

### Retire a version

Deprecation and sunset dates are announcements. Nothing switches off on a timer. When you're ready, delete the version from the family and remove its normalizers and serializers. Requests asking for it then get a 400.

Generate OpenAPI for a specific version with `cricket docs --api-version sessions.sdk=2025-11-15`.

## Generate OpenAPI

Your route contracts already describe your API, so Cricket can write the OpenAPI file for you. No separate spec to keep in sync!

```sh
pnpm exec cricket docs api/index.js --out openapi.json
```

This reads your app without starting the server or running `setup`. You get an OpenAPI 3.1 file with every route, schema, and status.

### Add the details clients need

Summaries, auth, headers, and examples all live on the route:

```js title="examples/public-contracts.js"
import {
  defineCricketApp, defineEndpoint, defineRule, defineSerializer, ok, unauthenticated, withHeaders, z
} from '@robdel12/cricket';

let requireUser = defineRule('report.requireUser', ({ user }) => {
  if (!user) throw unauthenticated('Sign in to read reports');
});

let showReport = defineEndpoint({
  method: 'get',
  path: '/reports/:id',
  summary: 'Read a report',
  auth: [{ bearer: [] }],
  params: z.object({ id: z.string() }),
  headers: z.object({ 'x-client-version': z.coerce.number().int().min(1).optional() }),
  rules: [requireUser],
  responses: {
    200: {
      schema: z.object({ id: z.string(), title: z.string(), details: z.json(), internalNote: z.string() }),
      serializer: defineSerializer({
        name: 'report.public',
        output: z.object({ id: z.string(), title: z.string(), details: z.json() }),
        serialize: ({ id, title, details }) => ({ id, title, details })
      }),
      headers: { 'Cache-Control': { schema: z.string(), example: 'private, no-store' } },
      example: { id: 'report-1', title: 'Race results', details: { laps: [61.2, 59.8] } }
    },
    401: {
      description: 'A user credential is required',
      schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
    }
  },
  handler: ({ input }) => withHeaders(ok({ id: input.params.id, title: 'Race results', details: { laps: [61.2, 59.8] }, internalNote: 'For staff' }), {
    'Cache-Control': 'private, no-store'
  })
});

// `auth` only documents the scheme. The rule above is what checks access.
export let app = defineCricketApp({
  name: 'Public contract example',
  version: '1.0.0',
  authMethods: { bearer: { type: 'http', scheme: 'bearer' } },
  domains: [{ name: 'report', endpoints: [showReport] }]
});
```

A few things to know:

- `authMethods` on the app names your auth schemes. `auth` on a route says which ones it takes. This only documents auth. Your rules still enforce it.
- `headers` parses the request headers you list and puts them in `input.headers`. Use lowercase names.
- When a response `schema` and `serializer` are both set, the docs show the serializer's output. Internal fields like `internalNote` above stay out of the docs and out of the response.

### Custom types

If Cricket can't describe a type, like a `Buffer` or a custom transform, generation fails rather than guessing. Describe it with `jsonSchema` metadata:

```js
let BinaryFile = z.instanceof(Buffer).meta({
  jsonSchema: { type: 'string', format: 'binary' }
});
```

That metadata only changes the docs, so check it against a real response.

### Review before you publish

The file includes every route you registered. Read through it before you share it, especially examples, which can still show private data if you put it there.

## Share domains with plugins

Got a feature several apps need, like an admin panel or a support tool? Put its domains in a package and share them as a plugin.

The trick is that the plugin doesn't touch your tables. It says what data it needs, and each app supplies that data from its own services.

### Write the plugin

A plugin is a name, a schema, and some domains. The schema lists the service methods the plugin calls, with Zod input and output for each.

```js
import { defineCricketPlugin, definePluginSchema, z } from '@robdel12/cricket';

let UserPage = z.object({
  items: z.array(z.object({ id: z.string(), email: z.email() })),
  nextCursor: z.string().nullable()
});

export let superAdminPlugin = defineCricketPlugin({
  name: 'super-admin',
  schema: definePluginSchema({
    services: {
      userSupport: {
        listUsers: {
          input: z.object({ search: z.string().optional() }),
          output: UserPage
        }
      }
    }
  }),
  domains: [userSupportDomain]
});
```

Keep `@robdel12/cricket` as a peer dependency so the plugin and app share one copy.

### Use it in an app

Add the plugin to `plugins`, then supply the methods it needs from your own data:

```js
import { superAdminPlugin } from '@acme/super-admin';

export let app = defineCricketApp({
  baseUrl: import.meta.url,
  domains: './domains',
  plugins: [superAdminPlugin],
  services({ services }) {
    return {
      ...services,
      userSupport: {
        async listUsers({ search }) {
          let rows = await services.accounts.search({ search });
          return {
            items: rows.map(row => ({ id: row.userId, email: row.primaryEmail })),
            nextCursor: null
          };
        }
      }
    };
  }
});
```

Cricket checks at startup that every method exists, and it validates the input and output of each call. Plugin routes show up in `inspect` and OpenAPI like your own.

### What stays with the app

Plugins only add domains. They can't add middleware, run migrations, or decide who's allowed in. Your app owns auth, policy, and tables, including migrations for any model a plugin brings along. Shipping a UI too? Export it from a separate package entry and load it through your frontend build.

See the [plugin composition example](../examples/plugin-composition/app.js) for a full app with [its plugin](../examples/plugin-composition/plugin.js).

## Host OAuth for MCP

Use Cricket's OAuth plugin to let an MCP client connect to your API through
your app's sign-in and consent flow.

Import `defineOAuthPlugin` from `@robdel12/cricket/oauth` and add
`defineOAuthPlugin({ paths, serviceName: 'oauth' })` to the app's `plugins`.
Set the plugin's `paths` for authorization, token exchange, revocation,
JWKS, authorization discovery, resource discovery, and the browser
interaction and consent page. Compose the `oauth` service with the public
origin, issuer, resource, and app hooks when the
app sets up its dependencies and domain services.

Cricket serves authorization code with S256 PKCE and resource-bound opaque
tokens. The app decides who can sign in, what a user can consent to, and how
to check the user's current access. Use `createOAuthClients` for configured
clients and Client ID Metadata Documents, and `fetchOAuthMetadata` for
bounded requests to public HTTPS metadata.

The app supplies a durable store to `createOAuthAuthorization` and
`createOAuthTokenService`. Run each store operation inside one database
transaction. Lock the grant and credential before consuming a code or
refresh token. Commit the consumed credential and its replacements together.
Keep the consumed marker until the credential expires so replay can revoke
the affected grant.

Test the browser consent and token flow over HTTP with your database. Cover
concurrent redemption, rejected exchanges, refresh rotation, and revocation.
Verify that revoking a connection leaves other connections working.

## Model domain state

Some features have real states. A report starts as a draft, gets submitted, and later gets published. What an event can do depends on where the report is right now.

That's a state machine, and Cricket uses [XState v6](https://stately.ai/docs) for them. You don't need to install it, `createMachine` comes with Cricket.

### Define the machine

Put it in a `*.machine.js` file in the domain. Give it an `id`, a `version`, and a schema for each event.

```js title="examples/report-publication.js"
import { createMachine, defineMachine, z } from '@robdel12/cricket';

export let submitReport = z.object({ title: z.string().trim().min(1) });

export let reportPublication = defineMachine(createMachine({
  id: 'reports.publication',
  version: '1',
  schemas: {
    context: z.object({ title: z.string().nullable() }),
    events: {
      'report.submitted': submitReport,
      'report.published': z.object({})
    }
  },
  context: { title: null },
  initial: 'draft',
  states: {
    draft: {
      on: {
        'report.submitted': ({ event }, enqueue) => {
          enqueue.emit({ type: 'report.publicationRequested', title: event.title });
          return { target: 'publishing', context: { title: event.title } };
        }
      }
    },
    publishing: {
      on: {
        'report.published': { target: 'published' }
      }
    },
    published: { type: 'final' }
  }
}));
```

Submitting a draft moves it to `publishing` and emits a `report.publicationRequested` event. Something else, usually a job, does the actual publishing.

### Run an event

Machines don't run in the background or hold state in memory. Your service loads the current state, asks the machine what happens, and saves the result.

```js
let snapshot = reportPublication.machine.resolveState({
  value: report.status,
  context: { title: report.title }
});

let result = await reportPublication.transition(snapshot, {
  type: 'report.submitted',
  title: input.title
});

if (result.kind === 'unhandled') return badRequest('This report cannot be submitted');
await reports.save(result.snapshot, result.emitted);
```

`transition` checks the event against its schema first. Then you get one of two results:

- `applied` means the event did something. Save `snapshot` and act on `emitted`.
- `unhandled` means the event was valid, but the current state doesn't accept it.

### Keep it safe

- Keep guards and transitions pure. No fetching or writing inside the chart.
- Save the new state and any follow-up work in the same transaction, then let a [job](guide.md#run-background-jobs) do the work. That way a crash can't lose it.
- Lock the row or use a conditional write when two events could land at once.
- Have HTTP and jobs call the same service. Check that a job attempt still owns the work before accepting a late result.

If your state needs more than a status column, `persist(snapshot)` gives you a JSON checkpoint and `restore(checkpoint)` reads it back. When you change a stored chart, bump its `version` and migrate old checkpoints with `machineVersions`.

`pnpm exec cricket new domain reports api/domains --with machine,service` scaffolds the files, and `cricket inspect` lists each machine's states and events.

## Run background jobs

Some work shouldn't happen during a request, like sending email or rendering a report. Jobs move it to a worker, and they keep the same contracts as your routes: validated input, your services, logs, and traces.

Use Redis to share a queue across processes. Use a local queue for one process and the test driver when testing job behavior.

### Define a job

Put jobs in a `*.jobs.js` file in the domain.

```js
import { z } from '@robdel12/cricket';
import { defineJob, redisQueue, retry } from '@robdel12/cricket/jobs';

export let generateReport = defineJob({
  name: 'reports.generate',
  input: z.object({ reportId: z.string(), accountId: z.string() }),
  queue: redisQueue({
    name: 'reports',
    idempotencyKey: ({ input }) => input.reportId
  }),
  retry: retry.exponential({ attempts: 3, delayMs: 2_000, maxDelayMs: 60_000 }),
  async run({ input, services, logger, trace }) {
    logger.info('report.started', { reportId: input.reportId });
    return trace.span('reports.render', () => services.reports.generate(input));
  }
});
```

The idempotency key means asking for the same report twice while one is still running gives you the existing job instead of a duplicate.

### Enqueue work

Create a producer in `setup` and pass it to your services as a dependency.

```js
import { createCricketJobs } from '@robdel12/cricket/jobs';

let producer = await createCricketJobs({
  jobs: [generateReport],
  queues: { redis: { url: process.env.REDIS_URL } }
});

await producer.jobs.enqueue(generateReport, { reportId, accountId });
```

Pass `runAt` or `delayMs` as a third argument to run it later. Pass `requestId: request.id` for HTTP work or `parentJobRunId: jobRunId` for work started by a job. Both link to the [workflow trace](guide.md#follow-a-request).

### Start a worker

Workers live in `api/workers/`.

```js
import { startCricketWorker } from '@robdel12/cricket/jobs';
import { app } from '../index.js';

let worker = await startCricketWorker(app, {
  queues: { redis: { url: process.env.REDIS_URL } }
});

let shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());

try {
  await worker.run({ signal: shutdown.signal, concurrency: 4 });
} finally {
  await worker.cleanup();
}
```

The worker waits on Redis instead of polling, so it picks up new work right away. When you abort, it stops claiming jobs and lets the running ones finish.

### Run jobs in one process

Give the job a `localQueue`, start the worker with `queues: { local: true }`, and enqueue through `worker.jobs`. Delays and cron run in memory.

If you build a producer separately in the same process, pass the same `createLocalQueueDriver()` instance as `queues.driver` to both. Each runtime with `queues.local: true` gets its own queue.

```js title="examples/local-queue.js"
import { defineCricketApp, defineJob, localQueue, startCricketWorker, z } from '@robdel12/cricket';

let refreshInbox = defineJob({
  name: 'inbox.refresh',
  input: z.object({ inboxId: z.string() }),
  queue: localQueue({ name: 'maintenance', coalesceKey: ({ input }) => input.inboxId }),
  run: ({ input, services }) => services.inbox.refresh(input.inboxId)
});

let app = defineCricketApp({
  domains: [{ name: 'inbox', jobs: [refreshInbox] }],
  setup: () => ({
    services: { inbox: { refresh: inboxId => ({ refreshed: inboxId }) } }
  })
});

let worker = await startCricketWorker(app, { queues: { local: true } });
try {
  await worker.jobs.enqueue(refreshInbox, { inboxId: 'feedback' }, { delayMs: 5000 });
  await worker.jobs.enqueue(refreshInbox, { inboxId: 'feedback' });
  console.log(await worker.drain());
} finally {
  await worker.cleanup();
}
```

The queue disappears when the process stops. Keep durable work in app tables and re-enqueue any pending work at startup. A `coalesceKey` replaces pending work with the same job and key. Cancel it with `jobs.cancelPending(job, key)`. Coalescing jobs reject Cricket retry policies. Keep their retry state in app tables.

### Retries, limits, and failures

- **Retries.** `retry.exponential` waits `delayMs`, doubles it each time, and stops at `maxDelayMs`.
- **Concurrency.** `concurrency.global` caps work across every worker. `concurrency.partition` keeps one account from hogging the queue.
- **Failures.** `jobFailure({ exhausted })` runs when the last retry fails, so you can mark a record as failed.
- **Priority.** Set `priority` on the queue. Higher numbers get claimed first.

### Recurring work

Add a `schedule` to run a job on a cron:

```js
schedule: cronSchedule({
  key: 'daily-reports',
  cron: '15 4 * * *',
  timezone: 'America/Chicago',
  input: ({ scheduledFor }) => ({ reportId: `daily:${scheduledFor.slice(0, 10)}`, accountId: 'system' })
})
```

No separate cron server needed. The worker runs due slots itself.

### Stuck jobs

Cricket keeps a heartbeat on running jobs, but it doesn't guess what "stuck" means for your work. Give the job a `recover` function that looks at the facts and decides:

```js
recover({ run, progress }) {
  if (run.heartbeatAgeMs > 2 * 60_000)
    return { action: 'retry', reason: { code: 'heartbeat_stale' } };

  if (run.ageMs > 10 * 60_000 && !progress.seen({ within: '10 minutes' }))
    return { action: 'retry', reason: { code: 'not_advancing' } };

  return { action: 'continue' };
}
```

Call `progress.update({ current, total })` from `run` so recovery has something to go on.

### Keep a history

Want a table of past runs for debugging? Add the job ledger in a migration:

```js
import { createJobLedgerTable } from '@robdel12/cricket/jobs';

export async function up(db) {
  await createJobLedgerTable(db);
}
```

It's execution history, not product state, so keep your real data in your own tables. You decide how long to keep history. Clean it up with `jobs.removeFinished(ids)`.

## Follow a request

When something goes wrong, you want to see what happened. Cricket logs every request with an ID, times the work you care about, and reports errors where you tell it to.

### Logging

Set up the logger on the app. Pretty output is great locally, JSON is what your log collector wants.

```js
export let app = defineCricketApp({
  domains: './domains',
  logger: {
    service: 'projects-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  }
});
```

Setup, services, rules, handlers, and jobs all get the same `logger`. Log events with structured fields so you can filter on them later:

```js
logger.info('project.created', { projectId: project.id });
```

Cricket redacts fields that look like secrets, like `authorization`, `cookie`, `password`, and `token`.

### Tracing

Wrap the slow or important bits in a span:

```js
let project = await trace.span('projects.find', { slug }, () => services.projects.findBySlug(slug));
```

When a request queues work, pass `{ requestId: request.id }` to `jobs.enqueue`. Cricket saves that link on the envelope. Pass the app logger to the producer to include the enqueue event in your JSON logs.

```js title="examples/request-job-trace.js"
import {
  createCricketJobs,
  createCricketLogger,
  createLocalQueueDriver,
  defineCricketApp,
  defineEndpoint,
  defineJob,
  localQueue,
  respond,
  startCricketApp,
  startCricketWorker,
  z
} from '@robdel12/cricket';

let publishReport = defineJob({
  name: 'reports.publish',
  input: z.object({ reportId: z.string() }),
  queue: localQueue({ name: 'reports' }),
  run: ({ input }) => ({ published: input.reportId })
});

let renderReport = defineJob({
  name: 'reports.render',
  input: z.object({ reportId: z.string() }),
  queue: localQueue({ name: 'reports' }),
  async run({ input, trace, jobs, jobRunId, requestId }) {
    let report = await trace.span('reports.renderDocument', () => ({ reportId: input.reportId }));
    await jobs.enqueue(publishReport, report, { parentJobRunId: jobRunId, requestId });
    return report;
  }
});

let logger = createCricketLogger();
let driver = createLocalQueueDriver();
let producer = await createCricketJobs({ queues: { driver }, logger });

let requestReport = defineEndpoint({
  method: 'POST',
  path: '/reports',
  body: z.object({ reportId: z.string() }),
  async handler({ input, request, trace }) {
    let { envelope } = await trace.span('reports.enqueue', () =>
      producer.jobs.enqueue(renderReport, input.body, { requestId: request.id })
    );
    return respond(202, { jobId: envelope.id });
  }
});

let app = defineCricketApp({
  domains: [{ name: 'reports', endpoints: [requestReport], jobs: [renderReport, publishReport] }],
  logger
});
let worker = await startCricketWorker(app, { queues: { driver } });

try {
  let server = await startCricketApp(app, { host: '127.0.0.1', port: 0 });
  try {
    let response = await fetch(new URL('/reports', server.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportId: 'r1' })
    });
    if (response.status !== 202)
      throw new Error(`Report enqueue failed with status ${response.status}`);
    await response.json();
    await worker.drain();
  } finally {
    await server.stop();
  }
} finally {
  await worker.cleanup();
}
```

A job can link work it starts by passing `parentJobRunId: jobRunId` to `jobs.enqueue`. Pass its `requestId` too when there is one. This also connects scheduled jobs to their children when there is no HTTP request.

Run the example and save its JSON logs. Use the request ID or any linked `jobRunId` from `job.started` to read the same workflow.

```sh
node examples/request-job-trace.js > cricket.log
pnpm exec cricket trace <id> < cricket.log
```

### Export events

Set `observability: { export: sendEvent }` on the app to send request, span, and worker events to your own client. Use `cricket inspect` to check whether exports are enabled. Cricket queues up to 256 waiting events per runtime and sends them one at a time. It drops new events when the queue is full. Shutdown clears the queue without waiting for exports. Flush your client in app cleanup if it manages its own buffer.

Export callbacks receive individual immutable events without replay or app services. Do asynchronous I/O in the callback and keep synchronous work small. Use `observe` when you need an awaited callback or the terminal replay in a test.

### Reporting errors

Give the app an `onError` hook to send failures to your error tracker. It gets the original exception plus the request, response, matched route, and logger.

Using Sentry? There's an adapter:

```js
import { sentryErrorHandler } from '@robdel12/cricket/sentry';
import * as Sentry from '@sentry/node';

export let app = defineCricketApp({
  domains: './domains',
  onError: sentryErrorHandler(Sentry),
  setup() {
    Sentry.init({ dsn: process.env.SENTRY_DSN });
    return { cleanup: () => Sentry.flush(2000) };
  }
});
```

It skips 4xx errors and adds the method, status, route, and request ID. It never sends headers, cookies, query strings, or bodies.

### Health checks

Your app can read `lifecycle` to see if Cricket is starting, ready, or shutting down. But whether your product is healthy is your call, so write your own health route that checks what matters, like the database.

## Test your API

The best test hits your API the way a client does. `createTestRuntime` starts your real app on a random port, so your tests run the same routes, rules, and database code as production.

### Write a test

Here are the tests from the [example app](../examples/projects/):

```js title="api/domains/projects/behavior.test.js"
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRuntime } from '@robdel12/cricket/test';
import { app } from '../../index.js';

async function start(t) {
  let { api, runtime, cleanup } = await createTestRuntime(app);
  t.after(cleanup);
  await runtime.dependencies.db.migrate.latest();
  return api;
}

let asAda = { headers: { authorization: 'Bearer ada' } };

test('creates a project and reads it back', async t => {
  let api = await start(t);

  let create = await api.post('/api/projects', {
    ...asAda,
    body: { slug: 'launch-plan', name: 'Launch plan' }
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.project.slug, 'launch-plan');
  assert.equal(create.body.project.owner_id, undefined);

  let read = await api.get('/api/projects/launch-plan', asAda);
  assert.equal(read.status, 200);
  assert.equal(read.body.project.name, 'Launch plan');
});

test('rejects bad input before the handler runs', async t => {
  let api = await start(t);
  let response = await api.post('/api/projects', { ...asAda, body: { slug: 'No Spaces', name: '' } });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
});

test('keeps projects private to their owner', async t => {
  let api = await start(t);
  await api.post('/api/projects', { ...asAda, body: { slug: 'secret', name: 'Secret' } });

  let response = await api.get('/api/projects/secret', { headers: { authorization: 'Bearer grace' } });
  assert.equal(response.status, 403);
});
```

The test database is in-memory SQLite, so each test starts fresh after running migrations. The `api` client takes `body`, `headers`, and `query`, and gives you back `status`, `headers`, and `body`.

Run them with:

```sh
pnpm exec cricket test
```

It finds `*.test.js` files under `api/`, `src/`, and `test/`, and sets `NODE_ENV=test` so your app picks its test database.

### What to check

Check what a client would notice: status codes, response bodies, validation errors, who's allowed in, and rows that got saved. Don't mock Cricket. Mock only things you don't own, like a payment API or the clock.

When you need to look under the hood, `testState` has the logs, traces, and timings for each request:

```js
let { api, testState } = await createTestRuntime(app);
let response = await api.get('/api/projects/launch-plan');

testState.request(response.requestId);
```

### Test jobs

Start a worker with the in-memory queue, then run the work yourself. No sleeping, no waiting.

```js
let worker = await startCricketWorker(app, {
  jobs: [generateReport],
  queues: { test: true },
  clock: { now: () => new Date('2026-06-19T09:16:00.000Z') }
});

await worker.jobs.enqueue(generateReport, { reportId: 'r1', accountId: 'a1' });
await worker.drain();
```

For scheduled jobs, set the clock, call `worker.schedules.tick()`, then `worker.drain()`.
