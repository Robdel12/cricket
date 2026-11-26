import { defineCricketApp, defineJob, localQueue, startCricketWorker, z } from '@robdel12/cricket';

let refreshInbox = defineJob({
  name: 'inbox.refresh',
  input: z.object({ inboxId: z.string() }),
  queue: localQueue({ name: 'maintenance', coalesceKey: ({ input }) => input.inboxId }),
  run: ({ input, services }) => services.inbox.refresh(input.inboxId)
});

let app = defineCricketApp({
  domains: [{ name: 'inbox', jobs: [refreshInbox] }],
  setup: () => ({
    services: { inbox: { refresh: inboxId => ({ refreshed: inboxId }) } }
  })
});

let worker = await startCricketWorker(app, { queues: { local: true } });
try {
  await worker.jobs.enqueue(refreshInbox, { inboxId: 'feedback' }, { delayMs: 5000 });
  await worker.jobs.enqueue(refreshInbox, { inboxId: 'feedback' });
  console.log(await worker.drain());
} finally {
  await worker.cleanup();
}
