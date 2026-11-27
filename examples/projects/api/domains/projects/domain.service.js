import { randomUUID } from 'node:crypto';
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export function createProjectsService({ db }) {
  let projects = createKnexRepository({ db, model: Project, insert: Project.row });

  return {
    findBySlug(slug) {
      return projects.findOne({ slug });
    },

    create({ ownerId, slug, name }) {
      return projects.insert({ id: randomUUID(), owner_id: ownerId, slug, name });
    }
  };
}
