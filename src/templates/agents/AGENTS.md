<!-- cricket-agent-guidance -->
## Cricket App Guidance

## App Shape

Cricket provides the architecture. Your app defines the behavior.

- `api/index.js` is the normal Node entrypoint and visible Cricket app wiring.
- `api/domains/` contains product API domains.
- `api/middleware/` contains request middleware such as auth extraction, request IDs, rate limits, raw webhooks, CORS, and frontend fallbacks.
- `api/services/` contains narrow app-wide capabilities that are not owned by one domain.
- `api/workers/` contains background worker entrypoints that start Cricket workers.
- `api/migrations/` contains app database migrations for `cricket migrate`.
- `api/dev/` contains local-only developer support code. It is not product architecture and must not be required by production runtime.

First-class means scaffolded, documented, inspectable, and agent-readable. It does not mean Cricket takes over auth policy, table design, product data policy, local tooling, or deployment.

Domains are Cricket's required default architecture, not optional organization.
Do not register product `endpoints`, `jobs`, or `models` directly on
`defineCricketApp`. `architecture: 'manual'` is only a migration escape hatch
for existing or embedded applications. Treat manual mode as visible tech debt,
do not introduce it in a fresh app, and remove it when the migration reaches a
deliberate domain cutover.

Cricket definition builders return stable contracts and reject unknown app or
endpoint options. Compose new definitions instead of mutating existing apps,
endpoints, rules, models, serializers, normalizers, or jobs after construction.

Setup returns `undefined` or `{ dependencies, services, cleanup }`. It receives
the app, database, lifecycle, logger, and a no-op startup trace. Service and
middleware initialization receive dependencies, lifecycle, and logger before
requests exist. Request context, rules, and handlers receive services,
lifecycle, dependencies, and request-scoped logger and trace capabilities. Job
`run` and failure handlers receive services, lifecycle, logger, trace, jobs,
and progress. Recovery receives evidence, time, logger, and trace for a pure
decision. Shutdown hooks receive the assembled runtime. Product health checks
may read `lifecycle`, but they still own database, worker, and deploy readiness.

## Domain Shape

- `*.model.js` owns durable row fields and public/private visibility.
- `*.validations.js` owns reusable request, source, and service input schemas.
- `*.normalizers.js` owns pure source-boundary projections for third-party, webhook, queue, import, or legacy payloads.
- `*.serializers.js` owns response projections and validates output contracts.
- `*.service.js` owns data and integration operations.
- `*.rules.js` owns auth, existence, ownership, and business preconditions.
- `*.routes.js` owns endpoint contracts.
- `*.jobs.js` owns background job contracts for validated asynchronous work.
- `*.test.js` tests endpoint behavior through HTTP and job behavior through the worker boundary.

The folder is the domain. Keep services boring, rules named, and routes thin.
Keep HTTP request behavior in `middleware/`, not in rules. Keep app-wide clients
and shared capabilities in `services/`, not in one random domain.
Keep source payload weirdness in `*.normalizers.js`, not scattered through
services and routes.
Keep create/update/search/import input contracts in `*.validations.js`, not on
the model. Routes still import validations explicitly; Cricket does not
auto-wire schemas by name.
If code affects product behavior, start in the domain that owns it. Reach for an
app service, worker, middleware, or migration only when the responsibility is
actually shared, asynchronous, HTTP-edge, or schema-changing. Keep `dev/`
local-only.

Before changing a Cricket app, run `pnpm cricket check api/index.js` and
`pnpm cricket inspect api/index.js`. A fresh project starts with
`pnpm cricket init .`.

## HTTP Contracts

Routes explicitly compose request schemas, rules, handlers, serializers, and
response schemas. Request validation errors may be descriptive to clients.
Response, serializer, and normalizer contract details are internal: inspect
them through logs, `onError`, or test state rather than exposing their schema
issues over HTTP.

Bare handler, middleware, and fallback return values are response bodies. Use
Cricket's `ok`, `created`, `respond`, and `redirect` functions when transport
status matters, then compose `withHeaders`, `withCookies`, or
`withResponseCleanup` when needed. Never use a `{ status, body }`-shaped object
as an implicit HTTP response.

API versioning is optional and endpoint-owned. Share one immutable
`defineApiVersions` family across participating routes and declare historical
body normalizers and response serializers through `apiVersions`. Keep the
current endpoint schemas as the base contract. Do not register versions on
`defineCricketApp`, put versions on models, or branch services and handlers by
client version. Endpoints without `apiVersions` ignore version headers.

## Jobs

Use `defineJob` for asynchronous work that needs validated input, retry policy,
recovery policy, and queue coordination. Job execution reuses app services,
lifecycle, and logger, then adds job-scoped trace, jobs, and progress.
Keep job contracts in domain-local `*.jobs.js` files when the work belongs to
one domain.

Redis is hot coordination: queue membership, leases, wakeups, attempts, delayed
availability, schedule materialization, and progress. App tables keep product
truth. Add Cricket's `cricket_jobs` ledger in a normal app migration when you
want execution history, but do not use it as the domain state model.

Queue policy is execution behavior. Claims prefer higher numeric priority in
the ready work they observe, with stable ties. Drivers evaluate resolved global
and partition limits while choosing work, and blocked partitions do not block
unrelated keys. Idempotency prevents a second unfinished run and releases
after completion or final failure. Envelopes, run state, events,
current-attempt evidence, and schedule-slot ownership remain after completion
or failure. The app owns retention windows and cleanup scheduling. Pass expired
ledger IDs to `jobs.removeFinished(ids)` so Cricket can remove its Redis records
without exposing key shapes. Delete only `removed` and `missing` ledger rows
after rechecking their status and retention cutoff. Redis reserves capacity and
changes queue state atomically. Each claimed attempt owns Cricket's lease,
evidence, retry, and settlement writes; apps still make product-side effects
idempotent or attempt-aware.

The built-in Redis client supports `redis://` and `rediss://` URLs, ACL
credentials, numeric database paths, and explicit Node TLS options. An
app-provided client also needs `duplicate()` so blocking wakeups use a dedicated
connection. The built-in driver targets standalone Redis, not Redis Cluster.

Use `cronSchedule` for recurring work. Schedules live on job contracts, not in
separate app cron sidecars. Test schedules through the worker boundary with a fixed
clock and `worker.schedules.tick()`.

Use `jobFailure({ retrying, exhausted })` when product records need to follow
retry decisions. The handlers run after Cricket has scheduled a retry or marked
the envelope failed, and they receive app capabilities instead of Redis objects.

Use `recover({ run, ledger, logs, spans, progress, now, logger, trace })` when
active jobs need app-owned recovery. Cricket provides normal job facts; the
job decides whether
to `{ action: 'continue' }`, `{ action: 'retry' }`, or `{ action: 'fail' }`.
Use normal `logger.info(...)`, `trace.span(...)`, and `progress.update(...)` as
the signals recovery reads. Recovery may be evaluated concurrently, so keep it
pure and idempotent. Cricket fences the resulting attempt transition and
reports whether it was applied.

Use `createCricketJobs` in producers that only enqueue work. Use
`startCricketWorker` in `api/workers/` entrypoints that execute work, then
`worker.run({ signal })` for the job loop. Configure `queues.redis` or an
app-provided `queues.driver` explicitly; only tests should opt into
`queues.test: true`. Workers wait for queue wakeups and delayed or cron
boundaries instead of polling. Exponential retries remain unclaimable until
their calculated backoff expires. Deploy checks and product health remain app
responsibility.
<!-- /cricket-agent-guidance -->
