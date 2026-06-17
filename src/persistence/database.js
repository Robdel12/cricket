import path from 'node:path';
import { fileURLToPath } from 'node:url';

import knex from 'knex';

export let defaultMigrationDirectory = './api/migrations';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function freezeDatabaseConfig(config) {
  return Object.freeze({
    ...config,
    migrations: Object.freeze({
      ...config.migrations
    })
  });
}

/**
 * Normalize the app-owned Knex config that Cricket uses for runtime and CLI work.
 *
 * Cricket only owns the shape it needs to make Knex boring to use: a real Knex
 * config object and the conventional migrations directory. Table design,
 * connections, pools, and query strategy stay in the app config.
 *
 * @param {object|undefined} database - Optional Knex config from defineCricketApp.
 * @returns {object|undefined} Frozen config with Cricket migration defaults.
 */
export function normalizeDatabaseConfig(database) {
  if (database === undefined)
    return undefined;

  if (!isPlainObject(database))
    throw new Error('database must be a Knex config object');

  let migrations = isPlainObject(database.migrations)
    ? database.migrations
    : {};

  return freezeDatabaseConfig({
    ...database,
    migrations: {
      ...migrations,
      directory: migrations.directory ?? defaultMigrationDirectory
    }
  });
}

function appRootFor(baseUrl) {
  if (!baseUrl)
    return undefined;

  let href = baseUrl instanceof URL ? baseUrl.href : String(baseUrl);
  let filePath = href.startsWith('file:')
    ? fileURLToPath(href)
    : path.resolve(href);

  let moduleDirectory = path.dirname(filePath);

  return path.basename(moduleDirectory) === 'api'
    ? path.dirname(moduleDirectory)
    : moduleDirectory;
}

function resolveMigrationDirectory(directory, baseDirectory) {
  if (!baseDirectory)
    return directory;

  if (Array.isArray(directory))
    return directory.map(item => resolveMigrationDirectory(item, baseDirectory));

  if (typeof directory !== 'string' || path.isAbsolute(directory))
    return directory;

  return path.resolve(baseDirectory, directory);
}

/**
 * Build the mutable Knex config handed to Knex.
 *
 * @param {object} database - Normalized database config.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - App definition URL for CLI migration paths.
 * @returns {object} Knex config safe for Knex to consume.
 */
export function knexConfigForDatabase(database, {
  baseUrl
} = {}) {
  let normalized = normalizeDatabaseConfig(database);

  if (!normalized)
    throw new Error('database config is required');

  let baseDirectory = appRootFor(baseUrl);

  return {
    ...normalized,
    migrations: {
      ...normalized.migrations,
      directory: resolveMigrationDirectory(
        normalized.migrations.directory,
        baseDirectory
      )
    }
  };
}

/**
 * Create the Knex handle Cricket owns for runtime or CLI work.
 *
 * @param {object} database - Normalized database config.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - App definition URL for CLI migration paths.
 * @returns {object} Knex database handle.
 */
export function createDatabaseConnection(database, options = {}) {
  return knex(knexConfigForDatabase(database, options));
}
