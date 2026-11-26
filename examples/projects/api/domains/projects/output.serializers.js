import { defineSerializer, pickFields } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export let serializeProject = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});
