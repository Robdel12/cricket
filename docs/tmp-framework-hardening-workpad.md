# Cricket Framework Hardening Workpad

Date: 2026-07-09
Status: Active

Temporary workpad: keep this file current across the hardening PRs, then remove it when every done criterion is satisfied.

## Goal

- Make every public Cricket contract own real, immutable, composable behavior, with production-safe HTTP and job boundaries and tests that prove the advertised outcomes.

## Why

- The HTTP core is sturdy, but several definition boundaries remain mutable or ambiguous.
- The jobs API advertises retry, concurrency, priority, retention, wakeups, and Redis durability beyond what the runtime currently enforces.
- Cricket's vision explicitly rejects hidden mutation, transport magic, polling waits, and contract theater.

## Current Repo Facts

- `src/jobs/runtime.js` immediately requeues exponential retries, polls every second, and never evaluates job concurrency policies.
- `src/jobs/drivers/redis.js` stores priority/retention-adjacent metadata but claims FIFO and settles work through non-atomic command sequences.
- `src/app.js`, `src/endpoint.js`, and `src/rule.js` return mutable definition contracts; `src/observability.js` freezes caller-owned nested event values.
- `src/endpoint.js` treats any bare object with `status` as a transport response.
- `src/errors.js` exposes Zod issues for internal response/serializer/normalizer failures.
- `src/openapi.js` documents an undeclared POST response as 200 while runtime behavior defaults to 201.
- `src/structure.js` scaffolds optional empty files and a passing test with no assertion.
- `test/jobs.test.js` proves worker behavior mainly through the test driver and protocol doubles, not a real concurrent Redis boundary.

## Target Shape

- Definition builders return stable immutable contracts without freezing live runtime handles or caller-owned values.
- Bare handler values are always domain response bodies; explicit response helpers own transport status, headers, cookies, redirects, streams, and cleanup.
- Public request failures stay descriptive while internal contract failures are redacted at HTTP and remain observable internally.
- Every documented job option changes execution behavior; unsupported options do not remain as inspect-only promises.
- Redis claim, retry, completion, failure, idempotency, and schedule transitions are atomic and tested against real Redis.
- Workers wait on concrete driver events and abort signals instead of polling timers.

## Work Checklist

### PR 1 - Definition Contract Integrity

- [x] `src/app.js`, `src/endpoint.js`, `src/rule.js` - close public option surfaces where appropriate and return stable definition contracts.
- [x] `src/observability.js`, `src/immutable.js` - emit immutable copied events without mutating caller values; make unsupported non-plain copying explicit.
- [x] `src/errors.js` - redact internal contract details from clients while preserving them for logs and `onError`.
- [x] `src/openapi.js` - keep default response status aligned with runtime for every method.
- [x] `test/*.test.js`, `README.md`, `vision.md`, `src/templates/agents/` - prove and document the resulting contract behavior.

### PR 2 - Explicit HTTP Responses

- [ ] `src/endpoint.js`, `src/http/response.js` - make function-shaped response helpers the only transport-control values; bare objects containing `status` or `redirect` remain bodies.
- [ ] Add explicit helpers for the transport outcomes Cricket supports without introducing an open-ended response builder object.
- [ ] Update HTTP, OpenAPI, examples, README, and generated guidance together.

### PR 3 - Worker Loop And Retry Truth

- [ ] `src/jobs/runtime.js` - require an explicit queue driver outside the test harness.
- [ ] Replace polling with an abortable driver wait contract that accounts for ready work and the next delayed/scheduled boundary.
- [ ] Calculate exponential retry availability from attempt, delay, maximum delay, and the injected clock; prove retries do not run early.
- [ ] Replace timer-owned heartbeat behavior with a driver/runtime lifecycle contract that is deterministic under test.

### PR 4 - Queue Policy Truth

- [ ] Enforce global and partition concurrency during claim/settlement across workers.
- [ ] Make priority affect claim order with deterministic tie-breaking.
- [ ] Define and enforce idempotency lifetime and queue retention, or remove those options from the public contract.
- [ ] Keep app product state outside Redis and `cricket_jobs`.

### PR 5 - Redis Production Safety

- [ ] Make claim, retry, completion, failure, idempotency, delayed promotion, and schedule materialization atomic.
- [ ] Support the Redis URL/auth/TLS contract Cricket documents, including `rediss://`, or require an app-provided client for unsupported connections.
- [ ] Add real Redis integration tests for concurrent workers, crashes between transitions, leases, retry delays, idempotency, and cleanup.

### PR 6 - Runtime And Scaffold Cleanup

- [ ] Replace the ambiguous dual-shape `setup` return with one explicit contract and align capability documentation with actual injection points.
- [ ] Scaffold only useful domain files or provide deliberate selections; never generate a passing assertion-free test.
- [ ] Mark disposable setup-time schema creation as demo/test-only and keep migration guidance authoritative.
- [ ] Remove source-file discovery noise from the normal `pnpm test` workflow.

## Verification

- `pnpm run check`
- `pnpm test`
- Focused HTTP, jobs, CLI, and Redis integration commands added by each PR.
- [ ] Each PR proves user-visible or operator-visible behavior at the boundary that consumes it.
- [ ] README, `vision.md`, examples, inspect/OpenAPI output, and generated agent guidance agree with runtime truth.

## Done Criteria

- [ ] No public option is accepted solely as unused metadata unless it is explicitly named inspect-only metadata.
- [ ] Definition-time contracts cannot drift after construction and Cricket never freezes caller-owned values.
- [ ] HTTP runtime behavior and OpenAPI output agree.
- [ ] Job execution semantics are deterministic, event-driven, atomic, and proven against real Redis.
- [ ] Full verification passes after every PR-sized lane.
- [ ] This temporary workpad is removed and the active goal can be marked complete.

## Decision Log

- 2026-07-09: Work proceeds as a sequence of reviewable PRs. Stop after each coherent lane for human review before continuing.
- 2026-07-09: Prefer clean public-contract cutovers; do not add compatibility shims or dual runtime paths.
- 2026-07-09: PR 1 preserves opaque schema and runtime-capability identities while copying and freezing Cricket-owned structural arrays and plain snapshots.
