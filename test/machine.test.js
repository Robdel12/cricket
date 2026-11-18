import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  badRequest,
  createJobLedgerTable,
  createMachine,
  defineCricketApp,
  defineCricketPlugin,
  defineEndpoint,
  defineJob,
  defineMachine,
  machineVersions,
  ok,
  redisQueue,
  resolveCricketApp,
  startCricketWorker,
  z
} from '@robdel12/cricket';
import { createTestRuntime } from '@robdel12/cricket/test';
import { reportPublication, submitReport } from '../examples/report-publication.js';
import { defineMachine as definePluginMachine } from '../src/machine.js?plugin-copy';

test('validates event payloads, returns plain facts and resumes a saved workflow', async () => {
  let draft = await reportPublication.initial();
  await assert.rejects(
    reportPublication.transition(draft.snapshot, { type: 'report.submitted' }),
    { code: 'VALIDATION_FAILED' }
  );
  await assert.rejects(
    reportPublication.transition(draft.snapshot, { type: 'xstate.stop' }),
    { code: 'VALIDATION_FAILED' }
  );
  let early = await reportPublication.transition(draft.snapshot, { type: 'report.published' });
  assert.equal(early.kind, 'unhandled');

  let submitted = await reportPublication.transition(draft.snapshot, {
    type: 'report.submitted', title: '   Storm report   '
  });
  assert.equal(draft.snapshot.value, 'draft');
  assert.equal(draft.snapshot.context.title, null);
  assert.deepEqual(submitted.emitted, [
    { type: 'report.publicationRequested', title: 'Storm report' }
  ]);
  assert.ok(Object.isFrozen(submitted.emitted[0]));

  let checkpoint = JSON.parse(JSON.stringify(await reportPublication.persist(submitted.snapshot)));
  await assert.rejects(reportPublication.restore({
    ...checkpoint,
    context: { title: 5 }
  }), /Invalid checkpoint/);
  await assert.rejects(reportPublication.restore({
    ...checkpoint,
    machine: { ...checkpoint.machine, version: '0.1' }
  }), /Expected a checkpoint/);

  let snapshot = await reportPublication.restore(checkpoint);
  let published = await reportPublication.transition(snapshot, { type: 'report.published' });
  assert.equal(published.snapshot.value, 'published');
  assert.equal(published.snapshot.status, 'done');
  assert.deepEqual(published.emitted, []);
  assert.equal(
    (await reportPublication.transition(published.snapshot, { type: 'report.published' })).kind,
    'unhandled'
  );

  let nextVersion = defineMachine(createMachine({
    id: reportPublication.id,
    version: '2',
    schemas: { events: { 'report.published': z.object({}) } },
    initial: 'inReview',
    states: { inReview: {} }
  }));
  let migrated = await machineVersions([reportPublication.machine, nextVersion.machine])
    .migrateSnapshot(checkpoint, {
      to: '2',
      migrations: { '1': stored => ({ ...stored, value: 'inReview' }) }
    });
  assert.equal((await nextVersion.restore(migrated)).value, 'inReview');
});

test('accepts acknowledgements and rejects effects that require a live runtime', async () => {
  let delivered = [];
  let contract = defineMachine(createMachine({
    id: 'review',
    version: '1',
    schemas: {
      input: z.object({ enabled: z.boolean() }),
      events: {
        'review.read': z.object({}),
        'review.delayed': z.object({}),
        'review.sent': z.object({})
      }
    },
    context: ({ input }) => ({ enabled: input.enabled }),
    initial: 'pending',
    states: {
      pending: {
        on: {
          'review.read': ({ context }) => context.enabled ? {} : undefined,
          'review.delayed': { target: 'waiting' },
          'review.sent': (_, enqueue) => enqueue(() => delivered.push('sent'))
        }
      },
      waiting: { id: 'waiting', route: true, after: { 500: { target: 'pending' } } }
    }
  }));

  await assert.rejects(contract.initial({}), { code: 'VALIDATION_FAILED' });
  let allowed = await contract.initial({ enabled: true });
  let blocked = await contract.initial({ enabled: false });
  assert.equal((await contract.transition(allowed.snapshot, { type: 'review.read' })).kind, 'applied');
  assert.equal((await contract.transition(blocked.snapshot, { type: 'review.read' })).kind, 'unhandled');
  await assert.rejects(contract.transition(allowed.snapshot, { type: 'review.sent' }), /unsupported effect/);
  await assert.rejects(contract.transition(allowed.snapshot, { type: 'review.delayed' }), /unsupported effect/);
  await assert.rejects(
    contract.transition(allowed.snapshot, { type: 'xstate.route', to: '#waiting' }),
    { code: 'VALIDATION_FAILED' }
  );
  assert.deepEqual(delivered, []);
});

test('rejects unsupported saved work before hydrating a child actor', async () => {
  let initialized = 0;
  let contract = defineMachine(createMachine({
    id: 'parent',
    version: '1',
    schemas: { events: { next: z.object({}) } },
    initial: 'ready',
    states: {
      ready: {},
      running: {
        invoke: {
          id: 'child',
          src: createMachine({ context: () => { initialized += 1; return {}; } })
        }
      }
    }
  }));
  let { snapshot } = await contract.initial();
  let checkpoint = await contract.persist(snapshot);
  await assert.rejects(contract.restore({
    ...checkpoint, value: 'running', children: { child: {} }
  }), /without timers or child actors/);
  assert.equal(initialized, 0);
});

test('restores parsed context and preserves JSON keys in checkpoints and emitted facts', async () => {
  let info = JSON.parse('{"__proto__":{"source":"report"}}');
  let contract = defineMachine(createMachine({
    id: 'review.amount',
    version: '1',
    schemas: {
      context: z.object({ amount: z.coerce.number(), info: z.unknown() }),
      events: { '*': z.object({}) }
    },
    context: { amount: 2, info },
    initial: 'pending',
    states: {
      pending: {
        on: {
          '*': ({ context }, enqueue) => {
            if (context.amount === 2) {
              enqueue.emit({ type: 'review.accepted', info: context.info });
              return { target: 'accepted' };
            }
          }
        }
      },
      accepted: {}
    }
  }));

  let { snapshot } = await contract.initial();
  let checkpoint = await contract.persist(snapshot);
  assert.deepEqual(checkpoint.context.info, info);
  let restored = await contract.restore({ ...checkpoint, context: { amount: '2', info } });
  for (let invalid of [{ type: ' ' }, Object.assign([], { type: 'review.finish' })]) {
    await assert.rejects(contract.transition(restored, invalid), { code: 'VALIDATION_FAILED' });
  }
  let accepted = await contract.transition(restored, { type: 'review.finish' });
  assert.equal(accepted.snapshot.value, 'accepted');
  assert.deepEqual(accepted.emitted, [{ type: 'review.accepted', info }]);
});

test('resolves plugin machines and rejects duplicate IDs across domains', async () => {
  let pluginMachine = definePluginMachine(reportPublication.machine);
  let plugin = defineCricketPlugin({
    name: 'publishing',
    domains: [{ name: 'reports', machines: [pluginMachine] }]
  });
  let app = defineCricketApp({ domains: [], plugins: [plugin] });
  assert.deepEqual((await resolveCricketApp(app)).machines, [pluginMachine]);
  assert.throws(() => defineCricketApp({
    domains: [{ name: 'otherReports', machines: [reportPublication] }],
    plugins: [plugin]
  }), /duplicate machine id reports\.publication/);
});

test('HTTP and a worker apply events to the same database-backed service', async () => {
  let directory = await mkdtemp(path.join(tmpdir(), 'cricket-machines-'));
  let runtime;
  let worker;
  let publish = defineJob({
    name: 'reports.publish',
    input: z.object({ id: z.string() }),
    queue: redisQueue({ name: 'reports' }),
    run: ({ input, services }) => services.reports.apply(input.id, { type: 'report.published' })
  });
  let app = defineCricketApp({
    logger() {},
    database: {
      client: 'sqlite3',
      connection: { filename: path.join(directory, 'reports.sqlite') },
      useNullAsDefault: true
    },
    domains: [{
      name: 'reports',
      machines: [reportPublication],
      jobs: [publish],
      services: {
        reports({ db }) {
          return {
            apply: (id, event) => db.transaction(async trx => {
              let row = await trx('reports').where({ id }).forUpdate().first();
              let snapshot = reportPublication.machine.resolveState({
                value: row.status,
                context: { title: row.title }
              });
              let result = await reportPublication.transition(snapshot, event);
              if (result.kind === 'unhandled')
                return { updated: false };

              let next = { status: result.snapshot.value, title: result.snapshot.context.title };
              await trx('reports').where({ id }).update(next);
              for (let fact of result.emitted)
                await trx('publication_outbox').insert({ report_id: id, type: fact.type });
              return { updated: true, status: next.status };
            })
          };
        }
      },
      endpoints: [defineEndpoint({
        method: 'post',
        path: '/reports/:id/submit',
        params: z.object({ id: z.string() }),
        body: submitReport,
        response: z.object({ status: z.literal('publishing') }),
        async handler({ input, services }) {
          let result = await services.reports.apply(input.params.id, {
            type: 'report.submitted', title: input.body.title
          });
          if (!result.updated)
            throw badRequest('Report already submitted');
          return ok({ status: result.status });
        }
      })]
    }]
  });

  try {
    runtime = await createTestRuntime(app);
    let db = runtime.runtime.dependencies.db;
    await createJobLedgerTable(db);
    await db.schema.createTable('reports', table => {
      table.string('id').primary();
      table.string('status').notNullable();
      table.string('title');
    });
    await db.schema.createTable('publication_outbox', table => {
      table.string('report_id').primary();
      table.string('type').notNullable();
    });
    await db('reports').insert({ id: 'one', status: 'draft' });

    let malformed = await runtime.api.post('/reports/one/submit', { body: {} });
    assert.equal(malformed.status, 422);
    assert.equal((await db('reports').first()).status, 'draft');

    let competing = await Promise.all([
      runtime.api.post('/reports/one/submit', { body: { title: 'Forecast' } }),
      runtime.api.post('/reports/one/submit', { body: { title: 'Forecast' } })
    ]);
    assert.deepEqual(competing.map(({ status }) => status).sort(), [200, 400]);
    assert.deepEqual(await db('publication_outbox'), [{
      report_id: 'one', type: 'report.publicationRequested'
    }]);

    worker = await startCricketWorker(app, { queues: { test: true } });
    // Model the outbox dispatcher by submitting the committed request to Cricket Jobs.
    let { report_id: id } = await db('publication_outbox').first();
    await worker.jobs.enqueue(publish, { id });
    await worker.drain();
    assert.deepEqual(await db('reports').first(), { id, status: 'published', title: 'Forecast' });
  } finally {
    try {
      try {
        await worker?.cleanup();
      } finally {
        await runtime?.cleanup();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
