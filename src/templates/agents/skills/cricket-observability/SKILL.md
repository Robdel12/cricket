---
name: cricket-observability
description: Work with Cricket logging, tracing, lifecycle state, test state, inspect output, request/job observability, or the cricket trace CLI. Use when adding, reviewing, debugging, or testing observability in a Cricket app.
---

# Cricket Observability Skill

Use this when a change touches how a Cricket app explains itself.

## Logger

- Use the Cricket logger shape passed through setup, services, rules, middleware, handlers, jobs, workers, startup, shutdown, and errors.
- Prefer structured metadata over formatted strings.
- Do not log secrets. Cricket redacts common secret-shaped keys, but app code should still avoid putting sensitive values in logs.
- Use child metadata for stable facts such as `requestId`, job identity, route identity, account IDs, or operation names.

## Trace

- Use `trace.span(name, metadata, fn)` around meaningful work, especially service calls, external calls, and job steps.
- Keep span names stable and domain-readable.
- Do not turn tracing into logging. Spans should explain timing and nesting.
- Use `pnpm cricket trace` with newline-delimited JSON logs when debugging one request timeline.

## Lifecycle

- Read `lifecycle` from setup, services, middleware, context, handlers, jobs, workers, and shutdown hooks.
- Use lifecycle state for readiness and shutdown decisions. Product health checks still decide whether the app is ready for traffic.
- Do not invent separate lifecycle globals.

## Debugging Flow

1. Run `pnpm cricket inspect api/index.js` to confirm loaded domains, routes, jobs, services, and observability posture.
2. Reproduce through HTTP or the worker boundary.
3. Use test state or Cricket logs to inspect request/job events, logs, spans, timings, and failures.
4. Add spans or metadata only where they improve diagnosis for the next operator.
