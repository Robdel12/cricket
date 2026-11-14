---
name: cricket-observability
description: Work with Cricket logging, tracing, lifecycle state, test state, inspect output, request/job observability, or the cricket trace CLI. Use when adding, reviewing, debugging, or testing observability in a Cricket app.
---

# Cricket Observability Skill

Use this when a change touches how a Cricket app explains itself.

## Logger

- Use the Cricket logger shape supplied at each runtime phase. Setup, services,
  middleware initialization, requests, jobs, shutdown, and errors receive a
  logger appropriate to their scope. Worker runtimes expose that logger to
  worker entrypoints.
- Prefer structured metadata over formatted strings.
- Use `format: 'pretty'` for local development: short UTC timestamps, event and
  request/job/span summaries, then indented metadata with full IDs and deduplicated
  span context. A custom `write` receives one event, which may span multiple lines.
- Pretty color follows stdout terminal detection and `NO_COLOR`; `color: true`
  or `color: false` overrides detection. Children inherit the setting.
- Keep `format: 'json'` for collection and `cricket trace`. JSON is the default
  and always stays one complete structured envelope per line without color.
- Automatic request snapshots omit `clientIp` and `peerIp`; do not add raw IP values to logs by default.
- Do not log secrets. Cricket redacts common secret-shaped keys, but app code should still avoid putting sensitive values in logs.
- Use child metadata for stable facts such as `requestId`, job identity, route identity, account IDs, or operation names.
- Endpoint API version families add bounded family, selected version, source,
  and optional client-version metadata to matched-route logs and traces. Use
  those fields to measure compatibility usage; never log unsupported raw header
  values.

## HTTP error reporting

- Configure app `onError` once. Its context includes the request, selected response,
  matched route, request logger, `handled` flag, and `phase` (`request` or `response`).
  Request/response/route may be absent when a failure precedes their construction.
- Use `withError(respond(status, safeBody), error)` for deliberately handled errors.
  It retains the original exception privately without freezing it or bypassing
  response validation. Declare distinct error schemas in `responses`.
- `sentryErrorHandler` from `@robdel12/cricket/sentry` uses an app-owned SDK. It
  skips request-phase 4xx and reports later writing/cleanup failures even after
  200 or 400. Each error identity is reported once per request phase.
- The adapter adds request IDs, route templates, method, operation, and status.
  It adds no raw paths, credentials, query values, or payloads. Original exception
  messages, properties, and causes still require app/SDK scrubbing.
- Apps own SDK initialization and environment policy. Flush in setup cleanup
  after HTTP work drains and app resources are released, using `finally` when
  resource cleanup can fail. `onShutdown` runs before draining; Cricket's
  configured database is destroyed after setup cleanup. Jobs and detached work
  keep their own failure hooks and shutdown ordering.
- A plain returned 500 has no exception to report. Use the hook and response
  helper rather than adding capture calls to each wrapper. `cricket inspect`
  shows whether reporting is configured.

## Trace

- Use `trace.span(name, metadata, fn)` around meaningful work, especially service calls, external calls, and job steps.
- Keep span names stable and domain-readable.
- Do not turn tracing into logging. Spans should explain timing and nesting.
- Setup receives a no-op startup trace. Real traces belong to request and job
  execution; shutdown hooks receive the assembled runtime without a synthetic
  trace.
- Use `pnpm cricket trace` with newline-delimited JSON logs when debugging one request timeline.

## Lifecycle

- Read `lifecycle` from setup, services, middleware, context, handlers, jobs,
  and shutdown hooks. Worker runtimes expose it to worker entrypoints.
- Use lifecycle state for readiness and shutdown decisions. Product health checks still decide whether the app is ready for traffic.
- Do not invent separate lifecycle globals.
- Request holds from `runtime.requests.pause()` leave lifecycle readiness unchanged. Await `hold.idle({ signal })` for accepted middleware/handler, stream, async cleanup, and terminal observer work. Abort keeps admission closed until explicit resume. Detached jobs remain app-owned.
- Producer and response cleanup errors use request error hooks/logs and the next relevant drain boundary. Do not send a second response after transport commits or turn ordinary client stream cancellation into a cleanup failure.

## Debugging Flow

1. Run `pnpm cricket inspect api/index.js` to confirm loaded domains, routes, jobs, services, and observability posture.
2. Reproduce through HTTP or the worker boundary.
3. Use test state or Cricket logs to inspect request/job events, logs, spans, timings, and failures.
4. Add spans or metadata only where they improve diagnosis for the next operator.
