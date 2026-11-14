---
name: cricket-testing
description: Write or review tests in a Cricket app. Use when testing HTTP endpoints, validation, rules, serializers, normalizers, jobs, schedules, retries, ledgers, observability, Cricket test state, or the cricket test CLI.
---

# Cricket Testing Skill

Use this when adding or changing Cricket tests.

## Principles

- Test user-visible behavior through the boundary that consumes it.
- Use HTTP tests for endpoints. Use the worker boundary for jobs.
- Do not mock Cricket internals. Mock only external services, time, or randomness.
- Prefer deterministic state transitions over sleeps, polling, or timing guesses.
- Assert outcomes: status codes, response shapes, validation errors, persisted rows, job events, traces, ledger rows, and product state.

## HTTP Tests

- Use `createTestRuntime(app)` to get a real Cricket runtime and local HTTP client.
- Drive requests with `api.get`, `api.post`, `api.patch`, and related helpers.
- Inspect `testState.request(requestId)`, `testState.trace(requestId)`, logs, lifecycle events, and timings when they matter to behavior.
- Keep app database setup explicit. The test runtime does not reset product state for you.
- Test proxy policy through real native HTTP peers: trusted HTTPS facts, untrusted spoofing, repeated XFF headers, and the first untrusted hop. Do not mock socket identity or parse raw transport in app tests.
- Use the harness/client `origin` for other real HTTP or browser clients.
- Pause with `runtime.requests.pause()` and await its `idle({ signal })` before resetting shared state. Each independent hold resumes explicitly after success. Aborting idle does not reopen admission; keep fixture control outside the paused runtime.
- Request idle joins awaited handlers, middleware, error hooks, streams, async response cleanup, and terminal observers, including work after client disconnect. App-owned jobs and detached promises need their own drain.
- Stop independent producers and long streams before test `cleanup()`. Cleanup closes admission/listener and releases dependencies once, without invoking standalone `onShutdown` hooks.

## Job Tests

- Start jobs with `startCricketWorker(app, { jobs, queues: { test: true } })`.
- Use fixed clocks for delayed and scheduled work.
- Direct `worker.schedules.tick()` and `worker.drain()` tests only need
  `clock.now`. Continuous `worker.run()` tests must also provide
  `clock.waitUntil` and advance that concrete deadline without sleeping.
- Call `worker.schedules.tick()` to materialize due cron slots, then `worker.drain()` to execute ready work.
- Assert product state, job runtime events, traces, progress, retries, failure handlers, and ledger rows when relevant.

## CLI

```sh
pnpm cricket test
pnpm cricket test api/domains/projects/projects.test.js --grep "creates"
pnpm cricket test --json
pnpm cricket test --output cricket-test-report.json
```

Use `pnpm test` for the app's normal suite when the repo already defines it.

When HTTP docs change, compare generated OpenAPI with actual HTTP requests and
responses. Cover the affected auth, headers, private fields, uploads, and
response types. Run the docs CLI without starting services. Don't mock Cricket.

For response projections, test current and historical HTTP output, required
selected facts, private-field stripping, and generated schemas. Prove focused
requests work without loading legacy-only data. Keep data requirements explicit
at the service boundary.
