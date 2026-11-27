import { created, defineEndpoint, z } from '@robdel12/cricket';
import { CreateProjectBody, ProjectParams } from './input.validations.js';
import { ownProject, requireUser, slugAvailable } from './access.rules.js';
import { Project } from './schema.model.js';
import { serializeProject } from './output.serializers.js';

let ProjectResponse = z.object({ project: Project.public });

export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  body: CreateProjectBody,
  rules: [requireUser, slugAvailable],
  response: ProjectResponse,
  async handler({ input, services, user }) {
    let project = await services.projects.create({ ownerId: user.id, ...input.body });
    return created({ project: serializeProject(project) });
  }
});

export let readProject = defineEndpoint({
  method: 'get',
  path: '/projects/:slug',
  params: ProjectParams,
  rules: [requireUser, ownProject],
  response: ProjectResponse,
  handler({ project }) {
    return { project: serializeProject(project) };
  }
});
