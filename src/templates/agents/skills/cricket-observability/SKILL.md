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
- Do not log secrets. Cricket redacts common secret-shaped keys, but app code should still avoid putting sensitive values in logs.
- Use child metadata for stable facts such as `requestId`, job identity, route identity, account IDs, or operation names.
- Endpoint API version families add bounded family, selected version, source,
  and optional client-version metadata to matched-route logs and traces. Use
  those fields to measure compatibility usage; never log unsupported raw header
  values.

## Error reporting

- Configure app `onError(error, { request, response, route, handled, phase })` once.
  It receives original thrown HTTP errors and handled failures marked with
  `withError(respond(status, safeBody), error)`. The original error is private;
  attaching it does not expose it to the client or freeze it.
- For Sentry, import `sentryErrorHandler` from `@robdel12/cricket/sentry` and pass
  the app-owned SDK. The adapter adds request IDs and matched route templates,
  and skips ordinary 4xx failures. Keep raw paths, credentials, payloads, and
  query values out of extras.
- Apps own SDK initialization and environment policy. Flush in setup cleanup
  after requests drain, not `onShutdown`, which runs before draining.
- A returned 500 without an attached error carries no original exception. Do not
  infer errors from response bodies or duplicate capture calls in route wrappers.
- Later stream/cleanup errors use `phase: 'response'`, including responses already
  sent with 200. Background jobs keep their existing failure hooks.
- `cricket inspect` shows whether `onError` is configured.

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
