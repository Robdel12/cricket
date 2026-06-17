import { loadAppDefinition } from '../app-contract.js';
import knex from 'knex';

import { knexConfigForDatabase } from './database.js';

function requireDatabase(app) {
  if (!app.database)
    throw new Error('App database is required for cricket migrate');

  return app.database;
}

function migrationNames(migrations) {
  return migrations.map(migration =>
    typeof migration === 'string' ? migration : migration.name
  );
}

/**
 * Run a Knex migration command from a Cricket app definition.
 *
 * @param {object} options
 * @param {string} options.command - Migration command name.
 * @param {string} options.appModule - Side-effect-free app definition module.
 * @param {string} [options.name] - Migration name for `make`.
 * @param {string} [options.environment] - Database environment to run against.
 * @param {boolean} [options.all=false] - Roll back all completed migrations.
 * @returns {Promise<object>} Plain command result for CLI formatting.
 */
export async function runMigrationCommand({
  command,
  appModule,
  name,
  environment,
  all = false
}) {
  let definition = await loadAppDefinition(appModule);
  let config = knexConfigForDatabase(requireDatabase(definition.app), {
    baseUrl: definition.moduleUrl,
    environment
  });
  let migrationsDirectory = config.migrations.directory;
  let db = knex(config);

  try {
    if (command === 'latest') {
      let [batch, migrations = []] = await db.migrate.latest();

      return {
        command,
        batch,
        migrationsDirectory,
        migrations: migrationNames(migrations)
      };
    }

    if (command === 'rollback') {
      let [batch, migrations = []] = await db.migrate.rollback(undefined, all);

      return {
        command,
        batch,
        migrationsDirectory,
        migrations: migrationNames(migrations)
      };
    }

    if (command === 'status')
      return {
        command,
        migrationsDirectory,
        status: await db.migrate.status()
      };

    if (command === 'list') {
      let [completed, pending] = await db.migrate.list();

      return {
        command,
        migrationsDirectory,
        completed: migrationNames(completed),
        pending: migrationNames(pending)
      };
    }

    if (command === 'current-version')
      return {
        command,
        migrationsDirectory,
        version: await db.migrate.currentVersion()
      };

    if (command === 'make') {
      if (!name)
        throw new Error('Migration name is required');

      return {
        command,
        migrationsDirectory,
        file: await db.migrate.make(name)
      };
    }

    throw new Error(`Unknown migrate command: ${command}`);
  } finally {
    await db.destroy();
  }
}

function formatMigrationList(label, migrations) {
  if (!migrations.length)
    return [`${label}: none`];

  return [
    `${label}:`,
    ...migrations.map(migration => `  ${migration}`)
  ];
}

/**
 * Format a migration command result for humans and agents.
 *
 * @param {object} result - Result from runMigrationCommand.
 * @returns {string} Terminal output.
 */
export function formatMigrationResult(result) {
  let lines = [
    `Migrations: ${result.migrationsDirectory}`
  ];

  if (result.command === 'latest' || result.command === 'rollback') {
    lines.push(`Batch: ${result.batch}`);
    lines.push(...formatMigrationList('Migrations run', result.migrations));
    return lines.join('\n');
  }

  if (result.command === 'status') {
    lines.push(`Status: ${result.status}`);
    return lines.join('\n');
  }

  if (result.command === 'list') {
    lines.push(...formatMigrationList('Completed', result.completed));
    lines.push(...formatMigrationList('Pending', result.pending));
    return lines.join('\n');
  }

  if (result.command === 'current-version') {
    lines.push(`Current version: ${result.version}`);
    return lines.join('\n');
  }

  if (result.command === 'make') {
    lines.push(`Created: ${result.file}`);
    return lines.join('\n');
  }

  return lines.join('\n');
}
