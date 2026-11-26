import { defineCricketApp, startCricketApp } from '@robdel12/cricket';
import { readUser } from './middleware/read-user.js';

export let app = defineCricketApp({
  name: 'Projects API',
  version: '1.0.0',
  baseUrl: import.meta.url,
  prefix: '/api',
  logger: {
    service: 'projects-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  },
  database: {
    client: 'sqlite3',
    useNullAsDefault: true,
    environments: {
      development: { connection: { filename: './projects.sqlite' } },
      test: { connection: { filename: ':memory:' } }
    }
  },
  domains: './domains',
  middleware: [readUser]
});

await startCricketApp(app, {
  port: process.env.PORT ?? 3000,
  main: import.meta.url
});
