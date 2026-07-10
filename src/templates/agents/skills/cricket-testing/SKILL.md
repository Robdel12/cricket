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
- When transport behavior changes, prove both sides of the boundary: explicit
  response helpers control HTTP details, while status-shaped domain objects
  remain ordinary response bodies.

## Job Tests

- Start jobs with `startCricketWorker(app, { jobs, queues: { test: true } })`.
- Use fixed clocks for delayed and scheduled work.
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
