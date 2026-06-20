import path from 'node:path';
import { fileURLToPath } from 'node:url';

import knex from 'knex';

export let defaultMigrationDirectory = './api/migrations';

let cricketDatabaseKeys = new Set([
  'base',
  'defaultEnvironment',
  'environment',
  'environments'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function freezeEnvironmentMap(environments) {
  return Object.freeze(Object.fromEntries(
    Object.entries(environments).map(([name, config]) => [
      name,
      Object.freeze({
        ...config
      })
    ])
  ));
}

function freezeDatabaseConfig(config) {
  return Object.freeze({
    ...config,
    migrations: Object.freeze({
      ...config.migrations
    })
  });
}

function mergePlainObjects(left = {}, right = {}) {
  let merged = {
    ...left
  };

  for (let [key, value] of Object.entries(right)) {
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value)
      ? mergePlainObjects(merged[key], value)
      : value;
  }

  return merged;
}

function databaseBaseConfig(database) {
  if (isPlainObject(database.base) && isPlainObject(database.environments))
    return database.base;

  return Object.fromEntries(
    Object.entries(database)
      .filter(([key]) => !cricketDatabaseKeys.has(key))
  );
}

function selectedDatabaseEnvironment(database, environment) {
  return environment
    ?? database.environment
    ?? process.env.CRICKET_DATABASE_ENV
    ?? process.env.NODE_ENV
    ?? database.defaultEnvironment
    ?? 'development';
}

function normalizeKnexConfig(database) {
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

/**
 * Normalize the app Knex config that Cricket uses for runtime and CLI work.
 *
 * Cricket accepts either one Knex config or a small environment map. The
 * environment map exists so apps can declare database environments once while
 * runtime, inspect, and migrations all resolve the same selected config.
 *
 * @param {object|undefined} database - Optional Knex config from defineCricketApp.
 * @param {object} [options]
 * @param {string} [options.environment] - Explicit database environment.
 * @returns {object|undefined} Frozen config with Cricket migration defaults.
 */
export function normalizeDatabaseConfig(database, {
  environment
} = {}) {
  if (database === undefined)
    return undefined;

  if (!isPlainObject(database))
    throw new Error('database must be a Knex config object');

  if (!isPlainObject(database.environments))
    return normalizeKnexConfig(database);

  let selectedEnvironment = selectedDatabaseEnvironment(database, environment);
  let selectedConfig = database.environments[selectedEnvironment];

  if (!isPlainObject(selectedConfig))
    throw new Error(`database environment "${selectedEnvironment}" is not configured`);

  let base = Object.freeze(databaseBaseConfig(database));
  let config = normalizeKnexConfig(mergePlainObjects(base, selectedConfig));

  return freezeDatabaseConfig({
    ...config,
    base,
    defaultEnvironment: database.defaultEnvironment,
    environment: selectedEnvironment,
    environments: freezeEnvironmentMap(database.environments)
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
 * @param {string} [options.environment] - Explicit database environment.
 * @returns {object} Knex config safe for Knex to consume.
 */
export function knexConfigForDatabase(database, {
  baseUrl,
  environment
} = {}) {
  let normalized = normalizeDatabaseConfig(database, {
    environment
  });

  if (!normalized)
    throw new Error('database config is required');

  let baseDirectory = appRootFor(baseUrl);
  let config = Object.fromEntries(
    Object.entries(normalized)
      .filter(([key]) => !cricketDatabaseKeys.has(key))
  );

  return {
    ...config,
    migrations: {
      ...config.migrations,
      directory: resolveMigrationDirectory(
        config.migrations.directory,
        baseDirectory
      )
    }
  };
}

/**
 * Create the Knex handle Cricket uses for runtime or CLI work.
 *
 * @param {object} database - Normalized database config.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - App definition URL for CLI migration paths.
 * @returns {object} Knex database handle.
 */
export function createDatabaseConnection(database, options = {}) {
  return knex(knexConfigForDatabase(database, options));
}
