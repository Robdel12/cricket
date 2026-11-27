# Redis operations

Use the built-in driver with standalone Redis. It accepts `redis://` and
`rediss://` URLs, ACL credentials, database numbers, and Node TLS options.
A custom Redis client needs `duplicate()` for blocking waits. Each duplicate
needs `disconnect()` to interrupt pending work on cancellation.

Use `producer.driver.checkConnection()` or `worker.driver.checkConnection()`
to check the existing Redis command connection. It returns
`{ status: 'connected' | 'disconnected' | 'closed' }`. Check worker progress,
blocking waits, and product readiness separately.

Claims prefer higher queue priority among visible ready jobs. Worker
`concurrency` bounds one process. Global and partition limits apply across
workers. An idempotency key blocks a duplicate unfinished run. Make product
effects idempotent or check attempt ownership before a write.

For recovery, inspect normal logs, spans, progress, and ledger data. Return a
`continue`, `retry`, or `fail` decision. Cricket applies the decision only if
it still owns the attempt.

Add the execution ledger with `createJobLedgerTable` in an app migration.
Redis keeps finished job records. Pick a retention cutoff, then call
`jobs.removeFinished(ids)` in batches. Recheck the status and cutoff before
deleting ledger rows for IDs returned as `removed` or `missing`. Use the job
API for cleanup so the app does not depend on Redis key names.
