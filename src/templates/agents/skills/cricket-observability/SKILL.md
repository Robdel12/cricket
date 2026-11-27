---
name: cricket-observability
description: Diagnose or change Cricket logs, traces, error reporting, readiness, request draining, and shutdown.
---

# Cricket Observability

1. Run `pnpm exec cricket inspect api/index.js` to see the loaded contracts
   and reporting setup.
2. Reproduce through HTTP or the worker. Get the request ID or `jobRunId`.
3. Run `pnpm exec cricket trace <id> < cricket.log` on the API and worker JSON
   logs. Either ID finds the request and its linked jobs.

Pass `{ requestId: request.id }` to `jobs.enqueue` when HTTP starts a job.
In a job, pass `{ parentJobRunId: jobRunId, requestId }` when enqueueing a
child so a job run ID can find the whole chain. Give producers the app logger
so the trace includes enqueue.

Use the logger Cricket supplies. Add stable fields with a child logger and
time real work with `trace.span(name, metadata, fn)`. Keep secrets, raw
forwarding details, and request bodies out of logs. The default JSON format
works with collectors and `cricket trace`. Use `format: 'pretty'` for
local reading.

Use `observability.export` for async delivery to an external client. It
receives individual events from a bounded queue and can drop events under
load or during shutdown. Use `observe` for awaited callbacks or replay.

Configure `onError` once for HTTP error reporting. Use
`withError(respond(status, safeBody), error)` when returning a safe error
body that should retain the original exception. Use status-specific schemas.
For Sentry, request holds, and shutdown order, read
[Errors and shutdown](references/errors-and-shutdown.md).
