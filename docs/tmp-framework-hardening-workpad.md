# Cricket Framework Hardening Workpad

Date: 2026-07-09
Status: Active

Temporary workpad: keep this file current across the hardening PRs, then remove it when every done criterion is satisfied.

## Goal

- Make every public Cricket contract own real, immutable, composable behavior, with production-safe HTTP and job boundaries and tests that prove the advertised outcomes.

## Why

- Cricket's public surface spans definition, HTTP, job, documentation, and
  generated-guidance contracts; drift in any one of them teaches apps the wrong
  framework shape.
- The remaining job risk is Redis durability: policy behavior exists, but its
  multi-command transitions are not yet atomic or proven against a real
  concurrent Redis boundary.
- Cricket's vision explicitly rejects hidden mutation, transport magic, polling waits, and contract theater.

## Current Repo Facts

- App, endpoint, rule, model, serializer, normalizer, and job definitions now
  return stable contracts without freezing caller-owned runtime values.
- Observer events copy Cricket-owned structure, internal output contract failures
  are redacted at HTTP, and runtime default statuses agree with OpenAPI.
- HTTP transport intent now comes from branded response helpers; bare handler,
  middleware, and fallback values remain response bodies.
- `src/jobs/runtime.js` now requires explicit queue configuration, waits on
  driver events and concrete delayed or cron deadlines, and schedules retries
  at calculated exponential-backoff availability times.
- Active claim heartbeats now use the same injected, abortable clock lifecycle
  as worker deadlines instead of an untestable interval.
- Resolved global and partition concurrency now travels in immutable envelopes.
  Claims use shared active work for capacity; terminal settlement releases it.
- Built-in drivers claim higher numeric priority first with creation time and
  envelope ID as deterministic ties.
- Idempotency owns one non-terminal run and releases after completion or final
  failure. The unused `retention` option and duplicate `redisQueue.partition`
  source of truth have been removed; partition identity comes from resolved
  concurrency policy.
- Redis policy transitions remain non-atomic until the production-safety lane.
- `src/structure.js` scaffolds optional empty files and a passing test with no assertion.
- The job suites are organized by definition, policy, worker lifecycle,
  failure, recovery, Redis, ledger, and schedule contracts. Redis behavior is
  still proven through protocol doubles, not a real concurrent Redis boundary.

## Target Shape

- Definition builders return stable immutable contracts without freezing live runtime handles or caller-owned values.
- Bare handler values are always domain response bodies; explicit response helpers own transport status, headers, cookies, redirects, streams, and cleanup.
- Public request failures stay descriptive while internal contract failures are redacted at HTTP and remain observable internally.
- Every documented job option changes execution behavior; unsupported options do not remain as inspect-only promises.
- Redis claim, retry, completion, failure, idempotency, and schedule transitions are atomic and tested against real Redis.
- Workers wait on concrete driver events and abort signals instead of polling timers.
- README, vision, examples, and generated skills describe one cohesive current
  framework contract. Revise or remove stale guidance instead of appending
  patch notes that preserve the order changes happened.

## Work Checklist

### PR 1 - Definition Contract Integrity

- [x] `src/app.js`, `src/endpoint.js`, `src/rule.js` - close public option surfaces where appropriate and return stable definition contracts.
- [x] `src/observability.js`, `src/immutable.js` - emit immutable copied events without mutating caller values; make unsupported non-plain copying explicit.
- [x] `src/errors.js` - redact internal contract details from clients while preserving them for logs and `onError`.
- [x] `src/openapi.js` - keep default response status aligned with runtime for every method.
- [x] `test/*.test.js`, `README.md`, `vision.md`, `src/templates/agents/` - prove and document the resulting contract behavior.

### PR 2 - Explicit HTTP Responses

- [x] `src/endpoint.js`, `src/http/response.js` - make function-shaped response helpers the only transport-control values; bare objects containing `status` or `redirect` remain bodies.
- [x] Add explicit helpers for the transport outcomes Cricket supports without introducing an open-ended response builder object.
- [x] Update HTTP, OpenAPI, examples, README, and generated guidance together.

### PR 3 - Worker Loop And Retry Truth

- [x] `src/jobs/runtime.js` - require an explicit queue driver outside the test harness.
- [x] Replace polling with an abortable driver wait contract that accounts for ready work and the next delayed/scheduled boundary.
- [x] Calculate exponential retry availability from attempt, delay, maximum delay, and the injected clock; prove retries do not run early.
- [x] Replace timer-owned heartbeat behavior with a driver/runtime lifecycle contract that is deterministic under test.

### PR 4 - Queue Policy Truth

- [x] Resolve global and partition concurrency into envelopes and enforce it through shared driver state; atomic Redis enforcement belongs to PR 5.
- [x] Make priority affect claim order with deterministic tie-breaking.
- [x] Define and enforce idempotency lifetime and queue retention, or remove those options from the public contract.
- [x] Keep app product state outside Redis and `cricket_jobs`.

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
- [ ] Each PR reads every affected documentation and skill file as a whole,
  reorganizes existing guidance where needed, and removes superseded or
  duplicative instructions rather than only appending new sections.

## Done Criteria

- [ ] No public option is accepted solely as unused metadata unless it is explicitly named inspect-only metadata.
- [ ] Definition-time contracts cannot drift after construction and Cricket never freezes caller-owned values.
- [ ] HTTP runtime behavior and OpenAPI output agree.
- [ ] Job execution semantics are deterministic, event-driven, atomic, and proven against real Redis.
- [ ] Documentation and generated skills read as a cohesive description of the
  current framework, not a timeline of completed hardening work.
- [ ] Full verification passes after every PR-sized lane.
- [ ] This temporary workpad is removed and the active goal can be marked complete.

## Decision Log

- 2026-07-09: Work proceeds as a sequence of reviewable PRs. Stop after each coherent lane for human review before continuing.
- 2026-07-09: Prefer clean public-contract cutovers; do not add compatibility shims or dual runtime paths.
- 2026-07-09: PR 1 preserves opaque schema and runtime-capability identities while copying and freezing Cricket-owned structural arrays and plain snapshots.
- 2026-07-10: PR 2 brands responses created by small public functions; bare values stay bodies across handlers, middleware, and fallbacks, while composable wrappers add headers, cookies, redirects, and stream cleanup.
- 2026-07-10: Documentation and generated skills are current-state contracts,
  not append-only change logs. Every lane must rewrite the surrounding guidance
  for cohesion and delete stale or redundant instructions.
- 2026-07-10: PR 3 uses one injected clock lifecycle for worker deadlines,
  retry availability, and active heartbeats. Queue drivers wake workers for
  ready work; the runtime supplies delayed and cron boundaries.
- 2026-07-10: PR 4 resolves queue policy into immutable envelopes. Priority and
  concurrency affect claims, idempotency lasts for one non-terminal run, and
  unsupported retention and duplicate partition configuration are removed.
