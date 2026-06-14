# Cricket Vision

Cricket is a tiny Node API framework for sturdy contracts in Koa + Knex apps.

The bet is that backend code stays easier to grow when every domain has the
same plain structure: models define contracts, serializers shape outgoing API
data, validations protect input shape, normalizers translate outside data,
services do product work, rules guard requests, and routes compose the pieces
without becoming a junk drawer.

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

Those files are the framework's expected shape:

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
  serializers, and response contracts.
- `test` proves endpoint behavior through the HTTP boundary.

Apps can use only the files a domain earns. Cricket's happy path should keep
the core files obvious, scaffolded, documented, and loaded when present. Tests
are scaffolded next to the endpoint contract, but they are not part of runtime
domain loading.

## App Structure

Cricket's core contract is the domain folder, but real apps have a few other
recurring responsibilities. The recommended app shape gives those jobs a home
without turning them into hidden framework behavior.

First-class means scaffolded, documented, inspectable, and agent-readable. It
does not mean Cricket secretly owns runtime behavior:

- `api/index.js` is the normal Node entrypoint and visible Cricket app wiring.
- `api/domains/` contains product API domains.
- `api/middleware/` contains HTTP edge behavior such as auth extraction, CORS,
  uploads, rate limits, raw webhooks, and frontend fallbacks.
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

Models own durable data contracts and visibility.

Put persisted row fields here. Use `field.public(...)` for fields that can
leave through the default public contract, and `field.private(...)` for fields
that require an explicit named view and serializer.

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

Cricket may scaffold and inspect this file, but it should not create a hidden
validation registry or auto-wire schemas by name.

### `*.normalizers.js`

Normalizers own source-boundary translation.

Put pure `defineNormalizer(...)` functions here when data comes from a
third-party API, CSV, webhook, queue payload, legacy system, or import feed. A
normalizer turns source-shaped data into an app-owned object before services
persist or reason over it.

Normalizers should not fetch, write to the database, enqueue work, check auth,
or know about Koa. Cricket validates source and output schemas when the
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

Services should not depend on HTTP by default. If a service needs Koa `ctx`,
pass it explicitly and treat that as edge work.

### `*.rules.js`

Rules own guards and preconditions.

Put auth checks, existence checks, ownership checks, visibility checks, billing
gates, feature limits, and business constraints here. Rules may load state for
the handler when loading it is part of the guard.

A rule should answer "can this request continue?" If it starts doing the actual
product operation, move that work into the service.

### `*.routes.js`

Routes own HTTP composition.

Put endpoint definitions here: method, path, params, query, body, auth, rules,
handler, response schema, OpenAPI metadata, and edge middleware. Routes should
read like a concise product flow: validate input, run rules, call services,
serialize output.

## Request Flow

```text
HTTP adapter
  -> request context and logger
  -> input validation
  -> auth requirement
  -> rules
  -> handler
  -> services
  -> serializers
  -> response validation
  -> HTTP response
```

Routes stay thin because the other files have real jobs.

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

## Runtime Reality

Koa and Knex are first-class, but Cricket should keep adapters at the edges.
The framework should never make real work harder by hiding the runtime:

- handlers can access request context;
- rules can access services, logger, params, query, body, and state;
- services can use `db`, `trx`, or app-owned dependencies;
- Koa `ctx` remains available when an endpoint needs edge behavior;
- Knex transactions remain available instead of being wrapped in a fake database
  API.

The goal is better organization, not a fantasy backend where hard cases do not
exist.

## Logging

Cricket should provide one logging story.

Apps configure and extend the logger: levels, redaction, transports, request
IDs, user IDs, domain metadata, and environment behavior. Cricket should then
pass that logger through app setup, request context, rules, handlers, services,
adapters, and error handling.

## Design Principles

**Plain functions win.** Keep models, serializers, rules, services, and
endpoints as functions and POJOs.

**Plain objects stay plain.** Cricket should not introduce model instances,
hidden mutation, decorators, or ORM-style lifecycles.

**Functional composition over framework ceremony.** Compose small functions with
explicit inputs and outputs. Avoid magic containers and class hierarchies.

**Strong contracts at real boundaries.** Validate request input, durable row
shape, normalized source data, serializer output, and outgoing API responses.
Do not add schemas for theater.

**First-class does not mean hidden ownership.** Cricket can scaffold
`normalizers`, `middleware/`, `services/`, `workers/`, `migrations/`, `dev/`,
and domain tests without taking over auth, imports, migrations, queues, local
tooling, or deployment.

**Folder structure is the convention and the enforcement.** The framework should
auto-load the expected domain files and make missing pieces obvious during
scaffold, inspect, docs, or startup work.

**Escape hatches stay honest.** Koa `ctx`, Knex `db`, and Knex `trx` are real
tools. Keep them reachable.

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
bigger win is the whole route/service/rule/serializer/model shape.

Cricket is not a codegen-heavy CLI. The CLI should create structure and
orientation, not write product behavior.

Cricket is not trying to hide Koa or Knex. It should make the common path
cleaner and still let the app reach the underlying tools.

## CLI And Agents

The CLI should make the right shape the easiest path:

```sh
cricket init app .
cricket new domain project api/domains
cricket inspect api/index.js
cricket docs api/index.js --out openapi.json
cricket init agents .
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
data work, rules for guards, serializers for outgoing API shape, and tests
through the HTTP API.

## Product Feel

Cricket should make API architecture feel obvious.

Tiny contracts for sturdy Node APIs.
