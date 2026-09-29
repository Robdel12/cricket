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
  async run({ input, services }) {
    return await services.projects.refreshIndex(input);
  }
});
