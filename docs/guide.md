<!-- Generated from source JSDoc. Run pnpm --filter cricket-docs generate --write-markdown. -->
# Using Cricket

Cricket is a small Node framework for building APIs. Give each route a contract for what goes in and what comes out. Put data work in services, and group the files that change together in a domain.

When you're ready to split your app into files, see [Organize your app](guide.md#organize-your-app).

## Your first route

You'll need Node 24 or newer and pnpm.

### Install Cricket

Run this in an empty project folder. If you already have a `package.json`, skip `pnpm init` and set `"type": "module"` there.

```sh
pnpm init --init-type module
pnpm add github:Robdel12/cricket
```

### Add a route

Save this as `api.js`.

```js
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

### Try it

Start the server.

```sh
node api.js
```

Leave it running and open a second terminal.

```sh
curl http://localhost:3000/hello/Cricket
```

You should get `{"message":"Hey, Cricket!"}`. Cricket checks the path params before calling your handler and parses the response before it sends it.

Once you want a folder for routes, services, and other domain code, run `pnpm exec cricket init .` and read [Organize your app](guide.md#organize-your-app).

## Organize your app

Start with `pnpm exec cricket init .`. It creates an app entry in `api/index.js`, the standard folders, and agent guidance in `AGENTS.md` and `.agents/skills/`. In an existing app, `pnpm exec cricket init agents .` adds the guidance on its own.

Put features in `api/domains/`. A project domain might start with `http.routes.js`, `input.validations.js`, and `domain.service.js`. Cricket loads direct files by suffix inside each domain folder. Add models, serializers, rules, machines, or jobs when the feature needs them.

```sh
pnpm exec cricket new domain project api/domains --with validations,service,routes,test
pnpm exec cricket check api/index.js
pnpm exec cricket inspect api/index.js
```

Use `check` to catch structure problems and `inspect` to see what the app loaded. For examples of the full folder layout and app setup, see [App shape in the README](../README.md#app-shape).

## Define route contracts

A route connects a method and path to your app. Use `defineEndpoint` to pass the Zod schemas for `params`, `query`, `body`, and `response` that the route needs. Put shared input schemas in a `*.validations.js` file and import them in the route.

Use `defineRule` for checks such as sign-in, ownership, and record existence. Put queries and writes in a service. That lets the same product operation run from a route or a background job.

### Shape data at the edges

A model describes a stored row. Use `field.public` and `field.private` to say what can leave the app, and add named views when different callers need different fields.

Use normalizers to shape data from webhooks, CSVs, and other outside sources. Use serializers to shape outgoing API data. `defineNormalizer` and `defineSerializer` can parse their output against a schema. See [a complete model-to-route example](../examples/one-file-app.js).

## Serve HTTP

Export a `defineCricketApp` contract from your app entry and pass it to `startCricketApp`. Set `main: import.meta.url` so CLI commands can import the app without opening a listener. App setup runs when the runtime starts and can return shared dependencies, services, and cleanup.

Most handlers return a body. Use `created(body)` for a 201, or `respond(status, body)` when the status should be explicit. For a route that already uses web-standard `Request` and `Response`, use a `fetch` handler and declare its status codes and media types in `fetchResponses`.

### Choose the request contract

Turn on `multipart` for uploads or `rawBody` when you need the original bytes. Configure trusted proxies when Cricket runs behind a proxy you control. If different clients need different versions of the same route, use `defineApiVersions` and declare the contracts for each version.

The README has examples for [Fetch handlers](../README.md#fetch-endpoints), [API versions](../README.md#endpoint-api-versions), [multipart requests](../README.md#multipart-requests), [trusted proxies](../README.md#configure-trusted-proxies), and [OIDC hosting](../README.md#host-oidc-inside-cricket).

## Connect a database

Set the Knex client and connection in the app's `database` config. Cricket creates the connection, passes `db` to your services, and closes it during shutdown. Install the driver for the database you use.

Use `createKnexRepository` when a service needs a small set of table operations. Your model describes the row, and your service owns the query and its access rules. Use Knex directly for queries that need more control.

Keep schema changes in `api/migrations/` and run them as a separate step when you deploy.

```sh
pnpm exec cricket migrate make api/index.js create_projects
pnpm exec cricket migrate latest api/index.js
pnpm exec cricket migrate status api/index.js
```

## Share domains with plugins

Use `defineCricketPlugin` when several apps share a domain or a package owns a set of routes. The plugin declares domains and the host app supplies the services its handlers need.

Use `definePluginSchema` to describe the methods, inputs, and outputs at that boundary. Cricket checks that the host provides those methods at startup and parses data at each call. Run `cricket inspect` to see which domains the plugin added.

See the [plugin composition example](../examples/plugin-composition/app.js) for the host and [the plugin factory](../examples/plugin-composition/plugin.js) it loads.

## Generate OpenAPI

Run the docs command against the app module you already serve. It reads the registered endpoint contracts without starting the server or running setup.

```sh
pnpm exec cricket docs api/index.js --out openapi.json
```

Add endpoint summaries, response types, request headers, and auth metadata when they help clients. Keep access checks in rules. Review which routes the generated file includes before sharing it.

See [the public contracts example](../examples/public-contracts.js) and the [OpenAPI options in the README](../README.md#document-your-http-api).

## Model domain state

Use a machine when a product event can do different things depending on the current state. A draft report can be submitted, and the same report can be marked published when a job succeeds.

Put the chart in a `*.machine.js` file. Pass a native XState v6 chart to `defineMachine` and give it an ID, a version, and schemas for its public events. Your service loads a snapshot, calls `transition(snapshot, event)`, and saves the result in a transaction. Store a checkpoint with `persist` and read it back with `restore` if the chart needs more than the state you already keep in a row.

Keep guards and transition callbacks pure. Save any work that has to survive a crash in the same transaction, then let a job deliver it. The [report publication example](../examples/report-publication.js) shows how a chart emits a request for work.

## Run background jobs

Put `defineJob` contracts in `*.jobs.js`. Give each job a name, an input schema, a queue, and a `run` function. Use the same services your routes use.

Call `jobs.enqueue` where you need to hand off work. In a worker entrypoint under `api/workers/`, use `startCricketWorker` to read jobs from the queue. Set retry and concurrency policy where you define the job, and use an idempotency key for work that can be requested twice.

Use `cronSchedule` for recurring work. Test scheduled work by advancing the test clock, calling `worker.schedules.tick()`, and draining available jobs. See the [jobs walkthrough](../README.md#jobs) for worker setup, retries, recovery, and the execution ledger.

## Follow a request

Cricket passes a logger to the app, routes, and workers. Use structured fields for details you want to filter later. Add trace spans around the service calls and external requests you need to time.

Pipe your JSON logs into `cricket trace <requestId>` to see one request's timeline. Configure `onError` if your app sends reports to an external service. Keep secrets out of logs and error reports.

See [logging and tracing](../README.md#logging-and-tracing) for configuration or [the shutdown example](../examples/request-pause.js) for draining requests and pausing traffic.

## Test your API

Use `createTestRuntime(app)` from `@robdel12/cricket/test` to run the real HTTP stack. Make requests through its `api` client and check the status, response, and any saved rows. Call `cleanup()` when the test ends.

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRuntime } from '@robdel12/cricket/test';
import { app } from './api.js';

test('greets the caller', async t => {
  let { api, cleanup } = await createTestRuntime(app);
  t.after(cleanup);

  let response = await api.get('/hello/Cricket');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: 'Hey, Cricket!' });
});
```

This test uses the app from [Your first route](guide.md#your-first-route). Run `pnpm exec cricket test`. Use the worker boundary to test jobs and a real test database for behavior that writes data.
