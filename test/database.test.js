import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  knexConfigForDatabase,
  normalizeDatabaseConfig
} from '../src/persistence/database.js';

describe('Cricket database contract', () => {
  it('keeps plain Knex configs working', () => {
    let config = knexConfigForDatabase({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      useNullAsDefault: true
    });

    assert.deepEqual(config, {
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      migrations: {
        directory: './api/migrations'
      },
      useNullAsDefault: true
    });
  });

  it('defaults migrations to the Cricket app convention', () => {
    let database = normalizeDatabaseConfig({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      }
    });

    assert.deepEqual(database.migrations, {
      directory: './api/migrations'
    });
  });

  it('selects and merges database environments', () => {
    let database = normalizeDatabaseConfig({
      client: 'pg',
      pool: {
        min: 1,
        max: 6
      },
      migrations: {
        tableName: 'cricket_migrations'
      },
      defaultEnvironment: 'development',
      environments: {
        development: {
          connection: 'postgres://localhost/dev'
        },
        test: {
          client: 'sqlite3',
          connection: {
            filename: ':memory:'
          },
          pool: {
            max: 1
          },
          useNullAsDefault: true
        }
      }
    }, {
      environment: 'test'
    });

    assert.equal(database.environment, 'test');
    assert.equal(database.client, 'sqlite3');
    assert.deepEqual(database.pool, {
      min: 1,
      max: 1
    });
    assert.deepEqual(database.migrations, {
      directory: './api/migrations',
      tableName: 'cricket_migrations'
    });
  });

  it('strips Cricket environment metadata before handing config to Knex', () => {
    let database = normalizeDatabaseConfig({
      client: 'pg',
      defaultEnvironment: 'development',
      environments: {
        development: {
          connection: 'postgres://localhost/dev'
        },
        test: {
          client: 'sqlite3',
          connection: {
            filename: ':memory:'
          },
          useNullAsDefault: true
        }
      }
    });
    let config = knexConfigForDatabase(database, {
      environment: 'test'
    });

    assert.deepEqual(config, {
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      },
      migrations: {
        directory: './api/migrations'
      },
      useNullAsDefault: true
    });
  });

  it('uses CRICKET_DATABASE_ENV when an environment is not explicit', () => {
    let previous = process.env.CRICKET_DATABASE_ENV;
    process.env.CRICKET_DATABASE_ENV = 'test';

    try {
      let database = normalizeDatabaseConfig({
        client: 'pg',
        environments: {
          development: {
            connection: 'postgres://localhost/dev'
          },
          test: {
            connection: 'postgres://localhost/test'
          }
        }
      });

      assert.equal(database.environment, 'test');
      assert.equal(database.connection, 'postgres://localhost/test');
    } finally {
      if (previous === undefined)
        delete process.env.CRICKET_DATABASE_ENV;
      else
        process.env.CRICKET_DATABASE_ENV = previous;
    }
  });

  it('rejects missing database environments', () => {
    assert.throws(
      () => normalizeDatabaseConfig({
        environments: {
          development: {
            client: 'pg',
            connection: 'postgres://localhost/dev'
          }
        }
      }, {
        environment: 'production'
      }),
      /database environment "production" is not configured/
    );
  });

  it('resolves CLI migration directories from the Cricket app root', () => {
    let moduleUrl = pathToFileURL('/tmp/cricket-app/api/index.js').href;
    let config = knexConfigForDatabase({
      client: 'sqlite3',
      connection: {
        filename: ':memory:'
      }
    }, {
      baseUrl: moduleUrl
    });

    assert.equal(
      config.migrations.directory,
      path.resolve('/tmp/cricket-app/api/migrations')
    );
  });

  it('rejects non-object database configs', () => {
    assert.throws(
      () => normalizeDatabaseConfig('postgres://localhost/app'),
      /database must be a Knex config object/
    );
  });
});
