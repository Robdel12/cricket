import knex from 'knex';
import { z } from 'zod';

import {
  camelCaseKeys,
  createKnexRepository,
  defineCricketApp,
  defineEndpoint,
  defineModel,
  defineRule,
  notFound,
  ok,
  pickFields,
  startCricketApp
} from '@robdel12/cricket';

let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: z.object({
    id: z.uuid(),
    owner_id: z.uuid(),
    slug: z.string(),
    name: z.string()
  }),
  create: z.object({
    slug: z.string().min(3),
    name: z.string().min(1)
  })
});

let ProjectPublic = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  slug: z.string(),
  name: z.string()
});

let serializeProjectPublic = camelCaseKeys(
  pickFields(['id', 'owner_id', 'slug', 'name'])
);

function createProjectService({ db }) {
  let projects = createKnexRepository({
    db,
    model: Project,
    insert: Project.row
  });

  return {
    findForUserBySlug({ userId, slug }) {
      return projects.findOne({
        owner_id: userId,
        slug
      });
    }
  };
}

let isKnownProject = defineRule('isKnownProject', async ({
  input,
  services,
  state,
  user
}) => {
  let project = await services.project.findForUserBySlug({
    userId: user.id,
    slug: input.params.slug
  });

  if (!project)
    return notFound('Project not found');

  state.project = project;
});

let readProject = defineEndpoint({
  method: 'get',
  path: '/projects/:slug',
  auth: true,
  params: z.object({
    slug: z.string().min(3)
  }),
  response: z.object({
    success: z.literal(true),
    project: ProjectPublic
  }),
  rules: [isKnownProject],
  async handler({ state }) {
    return ok({
      success: true,
      project: serializeProjectPublic(state.project)
    });
  }
});

let projectDomain = {
  name: 'project',
  models: [Project],
  endpoints: [readProject],
  services: {
    project: createProjectService
  }
};

export let app = defineCricketApp({
  name: 'One File API',
  version: '0.0.0',
  prefix: '/api',
  domains: [
    projectDomain
  ],
  async setup() {
    let db = knex({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      useNullAsDefault: true
    });

    await db.schema.createTable('project', table => {
      table.string('id').primary();
      table.string('owner_id').notNullable();
      table.string('slug').notNullable();
      table.string('name').notNullable();
    });

    await db('project').insert({
      id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0',
      owner_id: '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af1',
      slug: 'signal-notes',
      name: 'Signal Notes'
    });

    return {
      dependencies: {
        db
      },
      cleanup() {
        return db.destroy();
      }
    };
  },
  context({ ctx, dependencies, services }) {
    let token = ctx.get('authorization').replace('Bearer ', '');

    return {
      ...dependencies,
      services,
      user: token ? { id: token } : undefined
    };
  }
});

await startCricketApp(app, {
  port: 4017,
  main: import.meta.url
});
