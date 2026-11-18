import {
  defineJob,
  redisQueue,
  z
} from '@robdel12/cricket';

export let reindexProject = defineJob({
  name: 'projects.reindex',
  input: z.object({
    projectId: z.string()
  }),
  result: z.object({
    indexed: z.boolean()
  }),
  queue: redisQueue({ name: 'project-maintenance' }),
  async run({ input, envelope, attempt, services, trace }) {
    return await trace.span('projects.refreshIndex', { envelopeId: envelope.id, attempt }, () =>
      services.projects.refreshIndex(input)
    );
  }
});
