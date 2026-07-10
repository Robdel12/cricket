---
name: cricket-jobs
description: Build, review, or test Cricket jobs. Use when working with defineJob, redisQueue, retry, recover, jobFailure, cronSchedule, createCricketJobs, startCricketWorker, worker entrypoints, job ledgers, scheduled work, delayed work, or background processing in a Cricket app.
---

# Cricket Jobs Skill

Use this when work leaves the request path but should keep Cricket's contract shape.

## Shape

- Put jobs in domain-local `*.jobs.js` files, such as `api/domains/radar-jobs/radar.jobs.js` or `api/domains/radar-jobs/repair.jobs.js`.
- Use `defineJob` with validated `input`, optional `context`, queue metadata, retry policy, recovery policy, failure handlers, state metadata, and a plain `run`.
- Keep product truth in app tables and services. Redis coordinates hot execution: queues, wakeups, leases, attempts, delayed availability, schedules, and progress.
- Add `cricket_jobs` with `createJobLedgerTable` in an app migration when the app uses a Cricket database. Treat it as execution history, not product state.
- Use numeric queue priority when claim order matters. Claims prefer higher
  values among the ready work they observe, with creation time and envelope ID
  as stable ties.
- Use global concurrency for shared capacity and partition concurrency for
  tenant/account capacity. Cricket resolves both into the immutable envelope so
  queue drivers evaluate the same keys and limits while choosing work.
- Idempotency blocks duplicate non-terminal runs and releases on completion or
  final failure. Terminal envelopes, run state, events, current-attempt
  evidence, and schedule-slot ownership remain until the app deletes those
  prefixed Redis keys out of band.
- Redis reserves capacity and changes queue state atomically. Each claimed
  attempt owns Cricket's lease, evidence, retry, and terminal settlement
  writes. Apps still make product-side effects idempotent or attempt-aware.
- The built-in client accepts `redis://` and `rediss://` URLs, ACL credentials,
  numeric database paths, and Node TLS options. App-provided clients also need
  `duplicate()` for blocking wakeups.
- The built-in queue driver targets standalone Redis. Redis Cluster is not
  supported by the built-in driver.

## Producers And Workers

- Use `createCricketJobs` when code only needs to enqueue work.
- Use `startCricketWorker` in `api/workers/` entrypoints that execute jobs, then call `worker.run({ signal })`.
- Configure `queues.redis` or an app-provided `queues.driver` explicitly. Use
  `queues.test: true` only in tests; Cricket does not silently choose an
  in-memory queue.
- Worker loops block on queue wakeups and the next delayed or cron boundary.
  Abort the signal or call `worker.cleanup()` to stop that wait.
- Job `run` functions receive `input`, `context`, `services`, `logger`, `trace`, `lifecycle`, `jobs`, and `progress`. They should not receive Redis clients.
- Enqueue with `runAt` or `delayMs` for one-off delayed work.

## Scheduling

- Use `cronSchedule` on the job contract for recurring work.
- Keep cron, timezone, enablement, and due-slot input next to the job.
- Do not add separate app cron sidecars for Cricket jobs.
- Test schedules with a fixed clock, `worker.schedules.tick()`, and `worker.drain()`.

## Failure And Retry

- Use `retry.exponential` to decide whether Cricket should try again and when
  the next attempt becomes claimable. Delays double after each failed attempt
  and stop growing at `maxDelayMs`.
- Use `jobFailure({ retrying, exhausted })` when product records need to follow retry decisions.
- Failure handlers receive app capabilities plus `error`, `failure`, `envelope`, and `attempt`. Keep them focused on product state sync.
- If failure handlers throw, Cricket logs that handler failure and keeps the original job failure as the important error.

## Recovery

- Use `recover({ run, ledger, logs, spans, progress, now, logger, trace })` when
  active jobs need app-owned recovery decisions.
- Return plain decisions: `{ action: 'continue' }`, `{ action: 'retry', reason: { code, message } }`, or `{ action: 'fail', reason: { code, message } }`.
- Define stuck/dead/out-of-bounds in the job. Cricket provides the facts; the app decides what they mean.
- Use normal `logger.info(...)`, `trace.span(...)`, and `progress.update(...)` in `run`. Do not create separate recovery-only signaling.
- Keep recovery pure and idempotent because multiple recovery workers may
  evaluate the same attempt. It should inspect facts and return a decision,
  not write product state directly. Cricket fences the resulting transition
  and reports whether it was applied.
