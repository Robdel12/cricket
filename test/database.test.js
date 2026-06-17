import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  knexConfigForDatabase,
  normalizeDatabaseConfig
} from '../src/persistence/database.js';

describe('Cricket database contract', () => {
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
