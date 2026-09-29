import {
  defineEndpoint,
  ok
} from '@robdel12/cricket';

export let listProjects = defineEndpoint({
  method: 'get',
  path: '/projects',
  async handler({ services }) {
    return ok(await services.projects.listProjects());
  }
});
