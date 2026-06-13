# Cricket Vision

Cricket is a tiny Node API framework for sturdy contracts in Koa + Knex apps.

The bet is that backend code stays easier to grow when every domain has the
same plain structure: models define contracts, serializers shape outgoing API
data, services do data and product work, rules guard requests, and routes
compose the pieces without becoming a junk drawer.

## Core Shape

Cricket should enforce architecture through domain folders.

```text
api/
  project/
    project.model.js
    project.serializers.js
    project.service.js
    project.rules.js
    project.routes.js
```

Those files are the framework's expected shape:

- `model` defines durable Zod contracts and reusable schemas.
- `serializers` defines pure outgoing API projections.
- `service` defines product/data operations with explicit dependencies.
- `rules` defines named guards for auth, existence, ownership, billing,
  visibility, and business constraints.
- `routes` defines endpoints by composing schemas, rules, services,
  serializers, and response contracts.

Apps can add whatever else they need inside a domain folder. Cricket's happy
path should keep the core files obvious, scaffolded, documented, and
automatically loaded.

## Domain Files

### `*.model.js`

Models own durable data contracts and reusable boundary schemas.

Put Zod schemas here for row shape, create input, update input, IDs, enums,
params, query shapes, and reusable domain primitives. Use `defineModel(...)` for
persisted rows so bad data is caught when it enters or leaves storage.

Some domains do not own persisted data. They may still have a `*.model.js` with
request/response primitives and no `defineModel(...)` export. Do not create fake
tables or fake model contracts just to satisfy the framework.

### `*.serializers.js`

Serializers own outgoing API shape.

Put response schemas and pure projection functions here. They should accept
plain objects and return plain objects. This is where snake_case rows can become
camelCase API data, private fields can be dropped, and endpoint-specific public
shapes can be named.

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
shape, and outgoing API responses. Do not add schemas for theater.

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
cricket new domain project src/api
cricket inspect src/app.js
cricket docs src/app.js --out openapi.json
cricket init agents .
```

`cricket new domain` should scaffold the standard files. Command output should
explain the next useful step. That helps humans and gives agents a durable
checklist.

`cricket init agents` should ship project guidance that teaches the same
architecture humans use: domains by folder, schemas at boundaries, services for
data work, rules for guards, serializers for outgoing API shape, and tests
through the HTTP API.

## Product Feel

Cricket should make API architecture feel obvious.

Tiny contracts for sturdy Node APIs.
