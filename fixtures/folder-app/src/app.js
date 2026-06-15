import knex from 'knex';

import { defineCricketApp } from '../../../src/index.js';

export let app = defineCricketApp({
  name: 'Folder Build API',
  version: '1.0.0',
  prefix: '/api',
  domains: './api',
  async setup() {
    let db = knex({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      useNullAsDefault: true
    });

    await db.schema.createTable('build', table => {
      table.string('id').primary();
      table.string('user_id').notNullable();
      table.string('name').notNullable();
      table.boolean('public').notNullable().defaultTo(false);
    });

    return {
      dependencies: {
        db,
        ids: {
          next: () => '018f5f7e-9b5f-7d9a-8f69-3f6c3df71af0'
        }
      },
      cleanup() {
        return db.destroy();
      }
    };
  },
  context({ request, dependencies, logger, services }) {
    let token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    return {
      ...dependencies,
      logger,
      services,
      user: token ? { id: token } : undefined
    };
  }
});
