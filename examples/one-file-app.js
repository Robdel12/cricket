import knex from 'knex';

import {
  createKnexRepository,
  defineCricketApp,
  defineEndpoint,
  defineModel,
  defineRule,
  defineSerializer,
  field,
  notFound,
  ok,
  pickFields,
  startCricketApp,
  unauthenticated,
  z
} from '@robdel12/cricket';

let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: {
    id: field.public(z.uuid()),
    owner_id: field.private(z.uuid(), { sensitive: true }),
    slug: field.public(z.string()),
    name: field.public(z.string())
  }
});

let serializeProjectPublic = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});

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
  user
}) => {
  let project = await services.project.findForUserBySlug({
    userId: user.id,
    slug: input.params.slug
  });

  if (!project)
    return notFound('Project not found');

  return {
    project
  };
});

let requireUser = defineRule('requireUser', ({ user }) => {
  if (!user)
    return unauthenticated();
});

let readProject = defineEndpoint({
  method: 'get',
  path: '/projects/:slug',
  params: z.object({
    slug: z.string().min(3)
  }),
  response: z.object({
    success: z.literal(true),
    project: Project.public
  }),
  rules: [
    requireUser,
    isKnownProject
  ],
  async handler({ project }) {
    return ok({
      success: true,
      project: serializeProjectPublic(project)
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

function readUser() {
  return async (requestContext, next) => {
    let token = String(requestContext.request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    return await next({
      ...requestContext,
      context: {
        ...requestContext.context,
        user: token ? { id: token } : undefined
      }
    });
  };
}

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
  use: [readUser()],
  context({ dependencies, services }) {
    return {
      ...dependencies,
      services
    };
  }
});

await startCricketApp(app, {
  port: 4017,
  main: import.meta.url
});
