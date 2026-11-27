---
name: cricket-observability
description: Diagnose or change Cricket logs, traces, error reporting, readiness, request draining, and shutdown.
---

# Cricket Observability

1. Run `pnpm exec cricket inspect api/index.js` to see the loaded contracts
   and reporting setup.
2. Reproduce through HTTP or the worker. Find the request or job ID.
3. Use the test state or runtime logs to check events and spans. Run
   `pnpm exec cricket trace <requestId> < cricket.log` on newline-delimited
   JSON logs to see the request timeline. Use the job run ID to find job spans.

Use the logger Cricket supplies. Add stable fields with a child logger and
time real work with `trace.span(name, metadata, fn)`. Keep secrets, raw
forwarding details, and request bodies out of logs. The default JSON format
works with collectors and `cricket trace`. Use `format: 'pretty'` for
local reading.

Configure `onError` once for HTTP error reporting. Use
`withError(respond(status, safeBody), error)` when returning a safe error
body that should retain the original exception. Use status-specific schemas.
For Sentry, request holds, and shutdown order, read
[Errors and shutdown](references/errors-and-shutdown.md).
