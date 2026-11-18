import { createMachine, defineMachine, z } from '@robdel12/cricket';

export let submitReport = z.object({ title: z.string().trim().min(1) });

export let reportPublication = defineMachine(createMachine({
  id: 'reports.publication',
  version: '1',
  schemas: {
    context: z.object({ title: z.string().nullable() }),
    events: {
      'report.submitted': submitReport,
      'report.published': z.object({})
    }
  },
  context: { title: null },
  initial: 'draft',
  states: {
    draft: {
      on: {
        'report.submitted': ({ event }, enqueue) => {
          enqueue.emit({ type: 'report.publicationRequested', title: event.title });
          return { target: 'publishing', context: { title: event.title } };
        }
      }
    },
    publishing: {
      on: {
        'report.published': { target: 'published' }
      }
    },
    published: { type: 'final' }
  }
}));
