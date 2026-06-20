---
name: cricket-jobs
description: Build, review, or test Cricket jobs. Use when working with defineJob, redisQueue, retry, jobFailure, cronSchedule, createCricketJobs, startCricketWorker, worker entrypoints, job ledgers, scheduled work, delayed work, or background processing in a Cricket app.
---

# Cricket Jobs Skill

Use this when work leaves the request path but should keep Cricket's contract shape.

## Shape

- Put jobs in `api/domains/<domain>/<domain>.jobs.js` when the work belongs to one domain.
- Use `defineJob` with validated `input`, optional `context`, queue metadata, retry policy, failure handlers, state metadata, and a plain `run`.
- Keep product truth in app tables and services. Redis coordinates hot execution: queues, wakeups, leases, attempts, delayed availability, schedules, and progress.
- Add `cricket_jobs` with `createJobLedgerTable` in an app migration when the app uses a Cricket database. Treat it as execution history, not product state.

## Producers And Workers

- Use `createCricketJobs` when code only needs to enqueue work.
- Use `startCricketWorker` in `api/workers/` entrypoints that execute jobs, then call `worker.run()`.
- Job `run` functions receive `input`, `context`, `services`, `logger`, `trace`, `lifecycle`, `jobs`, and `progress`. They should not receive Redis clients.
- Enqueue with `runAt` or `delayMs` for one-off delayed work.

## Scheduling

- Use `cronSchedule` on the job contract for recurring work.
- Keep cron, timezone, enablement, and due-slot input next to the job.
- Do not add separate app cron sidecars for Cricket jobs.
- Test schedules with a fixed clock, `worker.schedules.tick()`, and `worker.drain()`.

## Failure And Retry

- Use `retry` to decide whether Cricket should try again.
- Use `jobFailure({ retrying, exhausted })` when product records need to follow retry decisions.
- Failure handlers receive app capabilities plus `error`, `failure`, `envelope`, and `attempt`. Keep them focused on product state sync.
- If failure handlers throw, Cricket logs that handler failure and keeps the original job failure as the important error.
