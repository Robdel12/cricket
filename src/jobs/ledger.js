function textValue(value) {
  return value === undefined ? undefined : JSON.stringify(value);
}

function timestamp(now = new Date()) {
  return now instanceof Date ? now.toISOString() : String(now);
}

function ledgerRowForEnvelope(envelope, now) {
  let queuedAt = timestamp(now);

  return {
    id: envelope.id,
    job_name: envelope.name,
    queue_name: envelope.queueName,
    idempotency_key: envelope.idempotencyKey,
    partition_key: envelope.partition,
    request_id: envelope.context?.requestId,
    source: envelope.context?.source,
    priority: envelope.priority,
    status: 'queued',
    attempts: 0,
    input: textValue(envelope.input),
    context: textValue(envelope.context),
    policy: textValue(envelope.policy),
    created_at: envelope.createdAt,
    queued_at: queuedAt,
    updated_at: queuedAt
  };
}

async function updateOrInsert(db, tableName, envelope, values) {
  let updated = await db(tableName)
    .where('id', envelope.id)
    .update(values);

  if (updated)
    return;

  await db(tableName).insert({
    ...ledgerRowForEnvelope(envelope),
    ...values
  });
}

/**
 * Create the framework-owned Cricket jobs ledger table.
 *
 * Use this helper from an app migration. Cricket does not create the table on
 * worker startup, because database changes should stay explicit and reviewable.
 *
 * @param {object} db - Knex database handle.
 * @param {object} [options]
 * @param {string} [options.tableName='cricket_jobs'] - Ledger table name.
 * @returns {Promise<void>}
 */
export async function createJobLedgerTable(db, {
  tableName = 'cricket_jobs'
} = {}) {
  await db.schema.createTable(tableName, table => {
    table.string('id').primary();
    table.string('job_name').notNullable();
    table.string('queue_name').notNullable();
    table.string('idempotency_key');
    table.string('partition_key');
    table.string('request_id');
    table.string('source');
    table.integer('priority');
    table.string('status').notNullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('input').notNullable();
    table.text('context').notNullable();
    table.text('policy').notNullable();
    table.text('latest_progress');
    table.text('result');
    table.text('last_error');
    table.string('job_run_id');
    table.string('created_at').notNullable();
    table.string('queued_at');
    table.string('started_at');
    table.string('finished_at');
    table.string('updated_at').notNullable();

    table.index(['status']);
    table.index(['job_name']);
    table.index(['queue_name']);
    table.index(['idempotency_key']);
    table.index(['request_id']);
  });
}

/**
 * Create a Cricket job ledger for one worker runtime.
 *
 * The ledger records execution history in the app database when a DB handle is
 * available. Without a DB, it becomes a no-op so Redis-only workers still run.
 *
 * @param {object} [options]
 * @param {object} [options.db] - Knex database handle.
 * @param {string} [options.tableName='cricket_jobs'] - Ledger table name.
 * @returns {object} Job ledger write API.
 */
export function createJobLedger({
  db,
  tableName = 'cricket_jobs'
} = {}) {
  if (!db)
    return {
      async queued() {},
      async started() {},
      async progressed() {},
      async completed() {},
      async retrying() {},
      async failed() {}
    };

  return {
    async queued(envelope) {
      await db(tableName).insert(ledgerRowForEnvelope(envelope));
    },

    async started(envelope, {
      attempt,
      jobRunId
    }) {
      await updateOrInsert(db, tableName, envelope, {
        status: 'active',
        attempts: attempt,
        job_run_id: jobRunId,
        started_at: timestamp(),
        updated_at: timestamp()
      });
    },

    async progressed(envelope, {
      progress
    }) {
      await updateOrInsert(db, tableName, envelope, {
        latest_progress: textValue(progress),
        updated_at: timestamp()
      });
    },

    async completed(envelope, {
      result
    }) {
      await updateOrInsert(db, tableName, envelope, {
        status: 'completed',
        result: textValue(result),
        finished_at: timestamp(),
        updated_at: timestamp()
      });
    },

    async retrying(envelope, {
      attempt,
      error
    }) {
      await updateOrInsert(db, tableName, envelope, {
        status: 'queued',
        attempts: attempt,
        last_error: textValue(error),
        updated_at: timestamp()
      });
    },

    async failed(envelope, {
      attempt,
      error
    }) {
      await updateOrInsert(db, tableName, envelope, {
        status: 'failed',
        attempts: attempt,
        last_error: textValue(error),
        finished_at: timestamp(),
        updated_at: timestamp()
      });
    }
  };
}
