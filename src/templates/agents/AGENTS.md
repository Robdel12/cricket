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

Cricket definition builders return stable contracts and reject unknown app or
endpoint options. Compose new definitions instead of mutating existing apps,
endpoints, rules, models, serializers, normalizers, or jobs after construction.

Cricket passes runtime capabilities such as `lifecycle`, `logger`, `services`,
`trace`, `jobs`, and `progress` through setup, middleware, context, handlers,
workers, and shutdown hooks. Product health checks may read `lifecycle`, but
they still own database, worker, and deploy readiness.

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

Request validation errors may be descriptive to clients. Response, serializer,
and normalizer contract details are internal: inspect them through logs,
`onError`, or test state rather than exposing their schema issues over HTTP.

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

## Jobs

Use `defineJob` for asynchronous work that needs validated input, retry policy,
recovery policy, Redis coordination, and the same
services/logger/trace/lifecycle/jobs/progress capabilities as HTTP.
Keep job contracts in domain-local `*.jobs.js` files when the work belongs to
one domain.

Redis is hot coordination: queue membership, leases, wakeups, attempts, delayed
availability, schedule materialization, and progress. App tables keep product
truth. Add Cricket's `cricket_jobs` ledger in a normal app migration when you
want execution history, but do not use it as the domain state model.

Use `cronSchedule` for recurring work. Schedules live on job contracts, not in
separate app cron sidecars. Test schedules through the worker boundary with a fixed
clock and `worker.schedules.tick()`.

Use `jobFailure({ retrying, exhausted })` when product records need to follow
retry decisions. The handlers run after Cricket has scheduled a retry or marked
the envelope failed, and they receive app capabilities instead of Redis objects.

Use `recover({ run, ledger, logs, spans, progress, now })` when active jobs need
app-owned recovery. Cricket provides normal job facts; the job decides whether
to `{ action: 'continue' }`, `{ action: 'retry' }`, or `{ action: 'fail' }`.
Use normal `logger.info(...)`, `trace.span(...)`, and `progress.update(...)` as
the signals recovery reads.

Use `createCricketJobs` in producers that only enqueue work. Use
`startCricketWorker` in `api/workers/` entrypoints that execute work, then
`worker.run()` for the job loop. Deploy checks and product health remain app
responsibility.
<!-- /cricket-agent-guidance -->
