# Cricket Vision

Cricket is a tiny Node API framework for sturdy contracts.

The bet is simple: backend code stays easier to grow when every part of the
system is plain, explicit, immutable by default, and easy to compose. Cricket
should make the right shape obvious without turning app code into framework
ceremony.

## Principles

**Plain functions win.** Models, normalizers, serializers, services, rules,
routes, jobs, and middleware should be plain functions and plain objects.

**Data stays plain.** Cricket should not introduce model instances, hidden
mutation, decorators, or ORM-style lifecycles.

**Composition beats magic.** Prefer explicit inputs and outputs over containers,
class hierarchies, auto-wiring by name, or hidden runtime behavior.

**Contracts live at real boundaries.** Validate request input, durable row
shape, normalized source data, job input, serializer output, and API responses.
Do not add schemas for theater.

**First-class does not mean hidden ownership.** Cricket can scaffold, load,
inspect, document, and test a shape. Apps still own product policy, auth,
tables, migrations, imports, queues, workers, health, and deployment.

**Agents are users.** Predictable files, predictable exports, small functions,
explicit dependencies, inspect output, OpenAPI output, and boundary tests make
apps easier for humans and agents to change safely.

## App Shape

Cricket apps should be readable from the filesystem:

```text
api/
  index.js
  domains/
  middleware/
  services/
  workers/
  migrations/
  dev/
```

`api/index.js` wires the app. `api/domains/` holds product behavior.
`api/middleware/` owns HTTP edge behavior. `api/services/` holds shared
capabilities. `api/workers/` starts background workers. `api/migrations/` holds
database history. `api/dev/` is local support, not production runtime.

This is guidance, not a cage. If an app earns another folder, it can have one.
Cricket should provide rails around the common mess without pretending every
app is the same.

## Domains

The domain folder is Cricket's core contract:

```text
project.model.js
project.validations.js
project.normalizers.js
project.serializers.js
project.service.js
project.rules.js
project.routes.js
project.jobs.js
project.test.js
```

Each file has one job:

- `model` defines durable row contracts, visibility, and sensitive fields.
- `validations` defines reusable body, params, query, source, and service input
  schemas.
- `normalizers` turns outside data into app data.
- `serializers` shapes outgoing API data.
- `service` does data and integration work.
- `rules` handles auth, existence, ownership, billing, and business guards.
- `routes` composes HTTP behavior.
- `jobs` defines validated asynchronous work.
- `test` proves behavior at the API or worker boundary.

Domains can use only the files they earn. Optional files stay optional, but the
standard names should stay predictable.

## Runtime

Cricket provides its HTTP runtime. It should not wrap another web framework or pass
foreign request/response objects through app code as an escape hatch.

The runtime should pass one consistent capability shape through setup,
middleware, rules, handlers, services, jobs, workers, shutdown hooks, logs, and
traces:

- `logger`
- `trace`
- `lifecycle`
- `services`
- `db` when Cricket provides the database handle
- request or job identity

Apps may read lifecycle state, but product health remains app responsibility. A Cricket
runtime can say it is starting, ready, shutting down, or stopped. It should not
decide whether your product is healthy enough to receive traffic.

## Data

Cricket is not an ORM.

It blesses Knex as the database path and can provide the runtime handle,
migration CLI, and named database environments. Apps still define table design,
migrations, indexes, transactions, query strategy, and product data policy.

`api/migrations/` is the convention. Cricket should not run migrations on server
start or invent a second database abstraction.

## Jobs

Jobs are Cricket contracts for background work.

A job should be an immutable envelope with validated input, explicit context,
queue metadata, retry policy, observable execution, recovery policy, and a
plain `run` function. Job code should receive the same app capabilities as HTTP
handlers: services, logger, trace, lifecycle, jobs, and progress.

Redis coordinates hot execution: queues, wakeups, leases, attempts, idempotency,
delayed availability, schedule materialization, and short-lived progress. The
app database keeps product truth. Cricket's `cricket_jobs` table is an
execution ledger for debugging and operators, not a domain state model.

Scheduled work should stay inside the job contract. Apps define the cron,
timezone, enablement rule, and input for each due slot. Cricket uses a thin cron
parser for schedule math, then materializes due slots into normal immutable job
envelopes. No separate app cron sidecars.

Recovery is a job-owned decision over normal Cricket signals: run state,
ledger, logs, spans, and progress. Cricket keeps those facts available and
executes the returned decision. The app defines what stuck, dead, or out of
bounds means.

Failure handling is first-class because retries are where framework truth and
product truth drift. Retry policy decides whether Cricket schedules another
attempt after thrown errors. `jobFailure({ retrying, exhausted })` lets app code
sync product records after that decision without knowing Redis internals.

## Observability

Cricket should provide one conservative observability story.

Logs are structured and stdout-first. Traces are safe, scalar, and tied to a
request or job. Timing data explains where time went; it should not become a
heavy observability product.

Cricket should never emit raw auth headers, cookies, query values, request
bodies, response bodies, `Set-Cookie` values, raw error objects, or open-ended
trace dumps by default.

`cricket trace` is a log renderer, not a storage backend or dashboard.

## Testing

Cricket's test layer should stay a thin vertical integration over the runtime it
already owns.

Tests should still be normal `node:test` files. Cricket can provide a real HTTP
client, worker hooks, safe request/job traces, structured logs, spans, timings,
and a small `cricket test` wrapper.

Cricket should not reset databases, fake auth, create factories, enforce speed
budgets, or bypass endpoint handling. Apps own setup and data policy.

## Inspect And Documentation

OpenAPI is the public HTTP spec.

`cricket inspect` is the framework topology map: domains, models, sensitive
fields, rules, services, jobs, routes, operation IDs, database posture, and
observability posture.

Keep those separate. Clients get a clean API spec. Humans and agents get the
framework shape.

## CLI And Agents

The CLI should create structure and orientation, not product behavior.

`cricket new domain` scaffolds the standard domain files. `cricket init app`
scaffolds the small app shell. `cricket init agents` ships project guidance and
local Cricket skills so agents learn the same architecture humans use.

The generated guidance is documentation. Keep it current when Cricket's public
contract changes.

## What Cricket Is Not

Cricket is not an ORM, generic backend platform, validation-only helper,
codegen-heavy CLI, or web-framework wrapper.

It is the small framework around the shape: immutable contracts, functional
composition, explicit runtime capabilities, and boring files that make sturdy
Node APIs easier to build.

## Product Feel

Cricket should make API architecture feel obvious.

Tiny contracts for sturdy Node APIs.
