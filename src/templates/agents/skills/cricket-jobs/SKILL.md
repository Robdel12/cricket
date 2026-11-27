---
name: cricket-jobs
description: Build or run background jobs in a Cricket app. Use for queue setup, worker entrypoints, scheduling, retry, recovery, and job history.
---

# Cricket Jobs

Put `defineJob` in a domain's `*.jobs.js`. Give it a stable name, an input
schema, a queue, and a `run` function that calls app services. A worker can
choose a subset of jobs from the app's domains.

## Choose a queue

- For one process, use `localQueue` and start the worker with
  `startCricketWorker(app, { queues: { local: true } })`. Enqueue through
  `worker.jobs`. If you build a producer separately with `createCricketJobs`,
  pass the **same** `createLocalQueueDriver()` instance as `queues.driver` to
  both. Let the worker own cleanup. Each `queues.local: true` creates its own
  queue, so two runtimes set up that way cannot share jobs.
- Local queues start empty after restart. Store durable work in app tables and
  rebuild pending wakeups at startup. A `coalesceKey` replaces pending work
  for the same job and key. An active run finishes first. Use
  `jobs.cancelPending(job, key)` to cancel a pending wakeup. Coalescing jobs
  cannot use `idempotencyKey` or a Cricket retry policy. Keep their retry
  state in the rows they read.
- For separate producer and worker processes, use `redisQueue` with explicit
  `queues.redis` configuration. See [Redis operations](references/redis.md)
  for connection, recovery evidence, and retention.

## Run the worker

Use `createCricketJobs` for enqueue-only processes and `startCricketWorker`
in `api/workers/` to execute jobs. Run `worker.run({ signal, concurrency })`
and call `worker.cleanup()` on shutdown. The loop waits for work and due times.

Use `runAt` or `delayMs` for one-off work and `cronSchedule` for recurring
work. Use `retry.exponential` for ordinary retryable jobs. Use
`jobFailure({ retrying, exhausted })` to update product records when Cricket
schedules a retry or marks a job failed. Use `envelope.id` and `attempt` to
guard writes from an older attempt. Keep `recover` read-only as several workers
may evaluate the same attempt.

Keep product state in app tables. Use the job ledger for execution history.
See [cricket-testing](../cricket-testing/SKILL.md) to test jobs with the worker.
