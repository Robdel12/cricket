import { badRequest, defineRule, forbidden, notFound, unauthenticated } from '@robdel12/cricket';

export let requireUser = defineRule('requireUser', ({ user }) => {
  if (!user) return unauthenticated();
});

// Rules can return facts. The handler gets `project` without loading it again.
export let ownProject = defineRule('ownProject', async ({ input, services, user }) => {
  let project = await services.projects.findBySlug(input.params.slug);

  if (!project) return notFound('Project not found');
  if (project.owner_id !== user.id) return forbidden();

  return { project };
});

export let slugAvailable = defineRule('slugAvailable', async ({ input, services }) => {
  if (await services.projects.findBySlug(input.body.slug))
    return badRequest('That slug is taken');
});
