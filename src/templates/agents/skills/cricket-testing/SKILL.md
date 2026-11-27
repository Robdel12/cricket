---
name: cricket-testing
description: Write or review Cricket tests. Use for real HTTP requests, worker execution, machine events, test state, and the Cricket test CLI.
---

# Cricket Testing

- **HTTP.** Import `createTestRuntime` from `@robdel12/cricket/test`.
  Register its `cleanup` with the test, make requests through `api`, and
  check status, response, and stored rows. Use a real test database when
  the endpoint writes data. Use the harness `origin` for other HTTP clients.
  Check OpenAPI against the real wire response when a public contract changes.
- **Jobs.** Use `startCricketWorker(app, { queues: { test: true } })`, enqueue
  through `worker.jobs`, and drain ready work. For schedules, advance a fixed
  clock and call `worker.schedules.tick()` before `worker.drain()`. A
  continuous `worker.run()` test also needs a clock with `waitUntil`.
  Use the real queue driver when testing driver behavior.
- **Machines.** Drive the real chart with events. Check accepted and
  unhandled outcomes, emitted facts, and checkpoints when the app saves
  them. Use HTTP or the worker and a real database to check concurrent
  writes or stale job results.
- **Pure functions.** Test normalizers and serializers directly when the
  main question is their data transformation.

Use the app's normal test command. In a scaffolded domain, a focused run
looks like this:

```sh
pnpm exec cricket test api/domains/projects/behavior.test.js --grep "creates"
```

Use `testState.request(requestId)` and `testState.trace(requestId)` when the
events or timings matter. Keep fixture setup explicit. Wait for concrete
results without sleeps, and mock only external services, time, or randomness.
If you reset shared state while a runtime is open, read
[how to pause and drain requests](../cricket-observability/references/errors-and-shutdown.md#drain-requests-and-stop).
