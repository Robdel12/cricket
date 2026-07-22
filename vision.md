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

**Definitions stay stable.** Cricket-owned app, endpoint, rule, model,
serializer, normalizer, and job contracts should not drift after construction.
Immutable snapshots must copy caller-owned plain data before freezing it.

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

**Guidance is a contract, not a changelog.** README, examples, and generated
agent skills should describe the current framework as one cohesive system.
Rewrite surrounding guidance and remove obsolete instructions when contracts
change instead of preserving the order implementation work happened.

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

This shape is an enforced default, not a suggestion. If an app earns another
folder, it can have one, but product endpoints, jobs, and models still enter the
runtime through domains. Existing applications may use an explicit manual
architecture while migrating. That escape hatch is visible tech debt, not a
parallel best practice.

## Domains

The domain folder is Cricket's core contract:

```text
schema.model.js
input.validations.js
source.normalizers.js
output.serializers.js
domain.service.js
access.rules.js
http.routes.js
*.jobs.js
behavior.test.js
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

Domains can use only the files they earn. Optional files stay optional, and
domain-local filenames can describe the slice they contain as long as they keep
Cricket's standard suffixes.

API compatibility belongs at the endpoint boundary. Apps may share an
immutable `defineApiVersions` family across routes, but each endpoint opts in
explicitly and declares only its historical normalizer and serializer deltas.
The current endpoint schemas remain the base contract. Models, services, rules,
and handlers stay versionless, and `defineCricketApp` does not own an API
version registry. An endpoint without version metadata does not inspect or
reject version headers.

## Runtime

Cricket provides its HTTP runtime. It should not wrap another web framework or pass
foreign request/response objects through app code as an escape hatch.

Handler, middleware, and fallback return values are domain bodies by default.
Only explicit, function-shaped Cricket response helpers control status,
headers, cookies, redirects, streaming, and cleanup. This keeps domain objects
from accidentally becoming transport instructions because they happen to have
a field named `status` or `redirect`.

The runtime should expose capabilities deliberately at the phase that owns
them, not imply one universal bag:

- Setup returns one explicit `{ dependencies, services, cleanup }` contract.
- Setup, service composition, and middleware initialization receive lifecycle
  and logger before request or job identity exists.
- Request context, rules, and handlers receive services, lifecycle, setup
  dependencies, and request-scoped logger and trace capabilities.
- Job `run` and failure handlers receive services, lifecycle, logger, trace,
  jobs, and progress. Recovery receives evidence, time, logger, and trace for a
  pure decision.
- Shutdown hooks receive the assembled runtime rather than a synthetic request
  or job trace.

When Cricket provides `db`, it is a setup dependency and follows dependency
injection into request code. Jobs should normally reach data work through
services rather than a raw database handle.

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
plain `run` function. Job execution reuses assembled app services, lifecycle,
and logger, then adds job-scoped trace, jobs, and progress capabilities.
Recovery reads execution evidence and returns a pure decision.

Queue ownership should always be explicit. Workers wait for driver wakeups or
the next known delayed or cron boundary, and shutdown aborts that wait. They do
not poll on a framework interval.

Redis coordinates hot execution: queues, wakeups, leases, attempts, idempotency,
delayed availability, schedule materialization, and attempt evidence. The
app database keeps product truth. Cricket's `cricket_jobs` table is an
execution ledger for debugging and operators, not a domain state model.

Queue policy should be executable, not descriptive metadata. Claims prefer
higher numeric priority in the ready work they observe, with stable ties.
Global and partition limits travel as resolved immutable envelope data so
drivers evaluate the same keys and limits when choosing work. Idempotency owns
one unfinished run and releases after completion or final failure. Enqueue,
claim, retry, completion/failure, delayed promotion, and schedule
materialization are atomic. Each attempt owns Cricket's lease, evidence, retry,
and settlement writes. Cricket rejects stale coordination updates to those
fields. Apps still own idempotency or attempt-awareness for product-side
effects. Envelopes, run state, events, current-attempt evidence, and
schedule-slot ownership remain after completion or failure. Apps own retention
windows and schedule cleanup. Cricket owns a safe removal capability that
accepts finished job IDs, verifies their status, and removes its internal Redis
records without exposing key shapes.

Scheduled work should stay inside the job contract. Apps define the cron,
timezone, enablement rule, and input for each due slot. Cricket uses a thin cron
parser for schedule math, then materializes due slots into normal immutable job
envelopes. No separate app cron sidecars.

Recovery is a job-owned decision over normal Cricket signals: run state,
ledger, logs, spans, and progress. Cricket keeps those facts available and
executes the returned decision. The app defines what stuck, dead, or out of
bounds means. Recovery may be evaluated concurrently, so the decision stays
pure and idempotent while Cricket fences the resulting attempt transition and
reports whether it was applied.

Failure handling is first-class because retries are where framework truth and
product truth drift. Retry policy decides whether Cricket schedules another
attempt after thrown errors and when that attempt becomes available.
Exponential backoff is execution behavior, not inspect-only metadata.
`jobFailure({ retrying, exhausted })` lets app code sync product records after
that decision without knowing Redis internals.

## Observability

Cricket should provide one conservative observability story.

Logs are structured and stdout-first. Traces are safe, scalar, and tied to a
request or job. Timing data explains where time went; it should not become a
heavy observability product.

Cricket should never emit raw auth headers, cookies, query values, request
bodies, response bodies, `Set-Cookie` values, raw error objects, or open-ended
trace dumps by default.

Observer events are immutable copies. Emitting an event must never freeze or
otherwise mutate the app value used to create it.

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

`cricket inspect` is the framework topology map: architecture, domains, models,
sensitive fields, rules, services, jobs, routes, operation IDs, database
posture, and observability posture.

`cricket check` fails invalid architecture contracts and reports manual mode as
migration debt. Validation begins in `defineCricketApp` so runtime, workers,
docs, inspect, and tests share one contract rather than reconstructing intent.

Keep those separate. Clients get a clean API spec. Humans and agents get the
framework shape.

## CLI And Agents

The CLI should create structure and orientation, not product behavior.

`cricket new domain` requires apps to select the files a domain actually needs.
Its test scaffold is a visible todo until the app proves behavior through the
HTTP or worker boundary.
`cricket init` scaffolds the small app shell, project guidance, and local
Cricket skills together so agents learn the same architecture humans use.
Focused `init app` and `init agents` commands remain useful when adopting
Cricket inside an existing repository, but they are not the default path.

The generated guidance is documentation. When Cricket's public contract changes,
revise the relevant guidance as a whole and remove superseded instructions.

## What Cricket Is Not

Cricket is not an ORM, generic backend platform, validation-only helper,
codegen-heavy CLI, or web-framework wrapper.

It is the small framework around the shape: immutable contracts, functional
composition, explicit runtime capabilities, and boring files that make sturdy
Node APIs easier to build.

## Product Feel

Cricket should make API architecture feel obvious.

Tiny contracts for sturdy Node APIs.
