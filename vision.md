# Cricket Vision

Cricket is a tiny Node API framework for sturdy contracts.

The bet is that backend code stays easier to grow when every domain has the
same plain structure, and when the HTTP runtime speaks the same language as the
domain contracts. Models define durable data shape, validations protect input,
normalizers translate outside data, serializers shape outgoing API data,
services do product work, rules guard requests, and routes compose the pieces.

Cricket owns HTTP directly. It does not wrap another web framework or keep a
generic runtime boundary around just in case.

## Core Shape

Cricket should enforce architecture through domain folders.

```text
api/
  index.js
  domains/
    project/
      project.model.js
      project.validations.js
      project.normalizers.js
      project.serializers.js
      project.service.js
      project.rules.js
      project.routes.js
      project.test.js
  middleware/
  services/
  workers/
  migrations/
  dev/
```

Those files are the expected shape:

- `model` defines durable row contracts and public/private visibility.
- `validations` defines reusable Zod schemas for request, source, and service
  input contracts.
- `normalizers` defines pure source-boundary projections for third-party,
  legacy, webhook, queue, or import payloads.
- `serializers` defines pure outgoing API projections.
- `service` defines product/data operations with explicit dependencies.
- `rules` defines named guards for auth, existence, ownership, billing,
  visibility, and business constraints.
- `routes` defines endpoints by composing schemas, rules, services,
  serializers, response contracts, and HTTP metadata.
- `test` proves endpoint behavior through the HTTP boundary.

Apps can use only the files a domain earns. Cricket's happy path should keep
the core files obvious, scaffolded, documented, and loaded when present. Tests
are scaffolded next to the endpoint contract, but they are not part of runtime
domain loading.

## App Structure

Cricket's core contract is the domain folder, but real apps have recurring
responsibilities outside one domain. The recommended app shape gives those jobs
a home without turning them into hidden framework behavior.

First-class means scaffolded, documented, inspectable, and agent-readable. It
does not mean Cricket secretly owns product policy:

- `api/index.js` is the normal Node entrypoint and visible Cricket app wiring.
- `api/domains/` contains product API domains.
- `api/middleware/` contains request middleware such as auth extraction,
  request IDs, CORS, rate limits, raw webhooks, and frontend fallbacks.
- `api/services/` contains app-wide services that are not owned by one domain,
  such as email, media storage, payment clients, caches, and cross-domain
  summaries.
- `api/workers/` contains background worker entrypoints. Workers should call
  services; they should not become a second product layer.
- `api/migrations/` contains app-owned database migrations.
- `api/dev/` contains local-only developer support code such as wait-for-db
  helpers, fixture generators, local setup/reset helpers, and smoke-test
  harnesses.

This is guidance, not a cage. If an app earns another folder, it can have one.
Cricket should provide rails around the common mess without pretending every app
has the same shape.

Cricket should not provide a `scripts/` junk drawer. If code affects product
behavior, design it into a domain, app service, worker, middleware, or
migration. If code is only local development support, keep it in `api/dev/` and
keep it out of production runtime.

## Domain Files

### `*.model.js`

Models own durable data contracts, visibility, and sensitive-field markers.

Put persisted row fields here. Use `field.public(schema)` for fields that can
leave through the default public contract, and `field.private(schema)` for
fields that require an explicit named view and serializer. Fields default to
`sensitive: false`; add `{ sensitive: true }` when logging and observability
need to treat the field carefully.

The sensitive marker exists because logging and observability should start from
the same durable row contract instead of scattered redaction rules. Cricket only
records whether a field needs handling; product-specific categories belong in
app policy.

`defineModel(...)` should derive strict `row`, `public`, and named view schemas.
Models should not own request lifecycle contracts like create/update. Those
belong in validations.

Some domains do not own persisted data. They may skip `*.model.js` entirely or
keep shared schema primitives there without a `defineModel(...)` export. Do not
create fake tables or fake model contracts just to satisfy the framework.

### `*.validations.js`

Validations own input shape.

Put Zod schemas here for request bodies, params, queries, source payloads,
service inputs, and persistence inserts/updates when a named contract helps.
Routes, rules, services, and normalizers import the schemas they use.

Cricket should not create a hidden validation registry or auto-wire schemas by
name.

### `*.normalizers.js`

Normalizers own source-boundary translation.

Put pure `defineNormalizer(...)` functions here when data comes from a
third-party API, CSV, webhook, queue payload, legacy system, or import feed. A
normalizer turns source-shaped data into an app-owned object before services
persist or reason over it.

Normalizers should not fetch, write to the database, enqueue work, check auth,
or know about HTTP. Cricket validates source and output schemas when the
normalizer runs. Services and workers own side effects.

### `*.serializers.js`

Serializers own outgoing API shape.

Put `defineSerializer(...)` projections here. They should accept plain objects
and return plain objects. This is where private fields are dropped and
endpoint-specific public shapes can be named. Cricket validates serializer
output so leaks fail close to the source.

### `*.service.js`

Services own product and data operations.

Put database calls, transactions, writes, reads, cross-table workflows, and
integration calls here. Services should accept explicit dependencies such as
`db`, `trx`, `logger`, clients, ID generators, and config. They should return
plain data, usually parsed through model schemas.

Services should not depend on HTTP by default. If a service needs request data,
pass the specific value it needs.

### `*.rules.js`

Rules own guards and preconditions.

Put auth checks, existence checks, ownership checks, visibility checks, billing
gates, feature limits, and business constraints here. Rules may return
request-local facts for later rules and handlers when loading them is part of
the guard.

A rule should answer "can this request continue?" If it starts doing the actual
product operation, move that work into the service.

### `*.routes.js`

Routes own HTTP composition.

Put endpoint definitions here: method, path, params, query, body, rules,
handler, response schema, and OpenAPI metadata. Routes should read like a
concise product flow: validate input, run rules, call services, serialize
output.

## Source Ingest Flow

```text
source client or worker
  -> normalizer
  -> validation contract
  -> service
  -> database, queue, or app-owned side effect
```

Normalizers keep outside-system weirdness at the boundary. Services still own
fetching, transactions, persistence, retries, and downstream work.

## Observability

Cricket should provide one observability story.

Apps configure and extend the logger, but the HTTP runtime owns lifecycle
events, request IDs, safe snapshots, and replay artifacts. Cricket should pass a
request-scoped logger through setup, middleware, context, rules, handlers,
services, startup, shutdown, and error handling.

The default logger should be structured, stdout-first, and boring enough for
Docker and hosted runtimes. Cricket can provide CLI tools that read those
emitted facts, such as tracing one request by `requestId`, but it should not
become the storage backend.

Default observability must be conservative: no raw auth headers, cookies, query
values, request bodies, response bodies, `Set-Cookie` values, or raw error
objects.

## Inspect vs OpenAPI

OpenAPI is the public HTTP spec: paths, parameters, request bodies, responses,
schemas, and operation IDs.

`cricket inspect` is the framework topology map: domains, models,
sensitive-field markers, rules, services, routes, operation IDs, and
observability posture. Keep these separate so clients get a clean spec and
humans/agents get the framework shape.

## Design Principles

**Plain functions win.** Keep models, serializers, rules, services, endpoints,
and middleware as functions and POJOs.

**Plain objects stay plain.** Cricket should not introduce model instances,
hidden mutation, decorators, or ORM-style lifecycles.

**Functional composition over framework ceremony.** Compose small functions with
explicit inputs and outputs. Avoid magic containers and class hierarchies.

**Strong contracts at real boundaries.** Validate request input, durable row
shape, normalized source data, serializer output, and outgoing API responses.
Do not add schemas for theater.

**First-class does not mean hidden ownership.** Cricket can scaffold
`normalizers`, `middleware/`, `services/`, `workers/`, `migrations/`, `dev/`,
and domain tests without taking over auth policy, imports, migrations, queues,
local tooling, or deployment.

**Folder structure is the convention and the enforcement.** The framework should
auto-load the expected domain files and make missing pieces obvious during
scaffold, inspect, docs, or startup work.

**Escape hatches stay Cricket-shaped.** Request data, response primitives,
streams, cookies, files, and close hooks are real tools. Keep them explicit in
Cricket contracts instead of exposing a foreign transport object.

**Agents are first-class users.** Predictable files, predictable exports, small
functions, explicit dependencies, OpenAPI output, and HTTP-boundary tests make
the code easier for LLM agents to extend safely.

## What Cricket Is Not

Cricket is not an ORM. The app owns migrations, table design, query strategy,
indexes, and product-specific data behavior.

If an app uses Knex, its own `knexfile.js` or migration command should point at
`api/migrations/`. Cricket can scaffold and document the folder, but it should
not secretly configure database behavior.

Cricket is not a generic backend platform. It is opinionated about API
architecture, but it should stay small and plain.

Cricket is not a validation-only helper. Zod is the contract layer, but the
bigger win is the whole route/service/rule/serializer/model/runtime shape.

Cricket is not a codegen-heavy CLI. The CLI should create structure and
orientation, not write product behavior.

Cricket is not a web-framework wrapper. It owns its HTTP runtime.

## CLI And Agents

The CLI should make the right shape the easiest path:

```sh
pnpm cricket init app .
pnpm cricket new domain project api/domains
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket init agents .
```

`cricket new domain` should scaffold the standard files. Command output should
explain the next useful step. That helps humans and gives agents a durable
checklist.

`cricket init app` should scaffold the small recommended app shell: entrypoint,
domains, middleware, services, workers, migrations, and local dev support. It
should not create a config file, jobs folder, scripts folder, or runtime
abstraction.

`cricket init agents` should ship project guidance that teaches the same
architecture humans use: domains by folder, schemas at boundaries, services for
data work, rules for guards, serializers for outgoing API shape, middleware
for HTTP edge work, and tests through the HTTP API.

Cricket should also make endpoint coverage inspectable. Since the app contract
already knows every route, Cricket can compare the route surface against real
HTTP tests and show what is missing. A future command should make it boring to
ask, "which endpoints exist without at least one boundary test?" and should
help scaffold a small smoke test without pretending generated tests prove the
product. The contract is simple: if an endpoint exists, there should be at
least one request-level test that proves the consumed boundary works.

## Product Feel

Cricket should make API architecture feel obvious.

Tiny contracts for sturdy Node APIs.
