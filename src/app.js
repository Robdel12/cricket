import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectEndpoints,
  collectJobs,
  collectModels,
  loadDomains
} from './domain.js';
import { flattenRoutes } from './http/router.js';
import { assertKnownOptions } from './options.js';
import { normalizeDatabaseConfig } from './persistence/database.js';

let appOptionKeys = new Set([
  'allowedHosts',
  'architecture',
  'baseUrl',
  'context',
  'database',
  'description',
  'domains',
  'endpoints',
  'fallback',
  'jobs',
  'logger',
  'middleware',
  'models',
  'name',
  'observability',
  'onError',
  'onShutdown',
  'prefix',
  'services',
  'setup',
  'trustProxy',
  'version'
]);

let appArchitectures = new Set([
  'domains',
  'manual'
]);
let definedAppContract = Symbol('Cricket defined app contract');

function validateDomainSource(domains) {
  if (Array.isArray(domains) || domains instanceof URL)
    return;

  if (typeof domains === 'string' && domains.trim())
    return;

  throw new Error('defineCricketApp domains must be a path, URL, or array of inline domains.');
}

function architectureFor(options) {
  let architecture = options.architecture ?? 'domains';

  if (!appArchitectures.has(architecture))
    throw new Error(`defineCricketApp architecture must be one of: ${[...appArchitectures].join(', ')}`);

  if (architecture === 'manual') {
    if (Object.hasOwn(options, 'domains'))
      throw new Error('defineCricketApp manual architecture cannot configure domains. Remove architecture: \'manual\' after the app has migrated to domains.');

    return architecture;
  }

  if (!Object.hasOwn(options, 'domains'))
    throw new Error('defineCricketApp requires domains. Configure domains: \'./domains\', or use architecture: \'manual\' only as a temporary migration escape hatch.');

  validateDomainSource(options.domains);

  let directContracts = ['endpoints', 'jobs', 'models'].filter(key => Object.hasOwn(options, key));

  if (directContracts.length > 0)
    throw new Error(`defineCricketApp domain architecture cannot register ${directContracts.join(', ')} directly. Export those contracts from domain files, or use architecture: 'manual' only as a temporary migration escape hatch.`);

  return architecture;
}

function stableList(value) {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

function freezeAppContract(contract) {
  let stable = {
    ...contract
  };

  for (let key of [
    'allowedHosts',
    'domains',
    'endpoints',
    'jobs',
    'middleware',
    'models'
  ]) {
    if (Object.hasOwn(stable, key))
      stable[key] = stableList(stable[key]);
  }

  stable[definedAppContract] = Object.freeze({
    architecture: stable.architecture,
    domains: stable.domains,
    endpoints: stable.endpoints,
    jobs: stable.jobs,
    models: stable.models
  });

  return Object.freeze(stable);
}

function definedAppFor(app) {
  let definition = app?.[definedAppContract];

  if (!definition)
    return defineCricketApp(app);

  let replacedContracts = [
    'architecture',
    'domains',
    'endpoints',
    'jobs',
    'models'
  ].filter(key => app[key] !== definition[key]);

  if (replacedContracts.length > 0)
    throw new Error(`Composed Cricket apps cannot replace ${replacedContracts.join(', ')}. Define a new app contract instead.`);

  return app;
}

function hasLoadedDomains(domains) {
  return Array.isArray(domains) && domains.every(domain =>
    domain && typeof domain === 'object' && domain.name
  );
}

/**
 * Define the Cricket app contract that CLIs, docs generation, and runtimes all
 * consume. This is intentionally plain data plus setup/context functions.
 *
 * @param {object} options - App contract options.
 * @param {'domains'|'manual'} [options.architecture='domains'] - Manual is a migration escape hatch.
 * @param {string|URL|object[]} [options.domains] - Domain root or inline domains. Required unless architecture is manual.
 * @returns {object} Normalized Cricket app contract.
 */
export function defineCricketApp(options = {}) {
  assertKnownOptions(options, appOptionKeys, 'defineCricketApp');

  let architecture = architectureFor(options);
  let domains = options.domains ?? [];
  let loadedDomains = hasLoadedDomains(domains);
  let hasExplicitEndpoints = Object.hasOwn(options, 'endpoints');
  let hasExplicitJobs = Object.hasOwn(options, 'jobs');
  let hasExplicitModels = Object.hasOwn(options, 'models');
  let collectedDomains = loadedDomains ? {
    endpoints: collectEndpoints(domains),
    jobs: collectJobs(domains),
    models: collectModels(domains)
  } : {};
  let endpoints = hasExplicitEndpoints ? options.endpoints : collectedDomains.endpoints;
  let jobs = hasExplicitJobs ? options.jobs : collectedDomains.jobs;
  let models = hasExplicitModels ? options.models : collectedDomains.models;
  let allowedHosts = options.allowedHosts;
  let prefix = options.prefix ?? '';
  let trustProxy = options.trustProxy ?? false;
  let middleware = options.middleware ?? [];
  let database = normalizeDatabaseConfig(options.database);

  let contract = freezeAppContract({
    ...options,
    architecture,
    domains,
    allowedHosts,
    ...(database === undefined ? {} : { database }),
    prefix,
    trustProxy,
    middleware,
    ...(endpoints === undefined ? {} : { endpoints }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(models === undefined ? {} : { models })
  });

  return contract;
}

/**
 * Resolve a Cricket app contract into loaded domains, endpoints, and models.
 *
 * @param {object} app - App returned by {@link defineCricketApp}.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - Module URL used to resolve relative domain paths.
 * @returns {Promise<object>} App contract with concrete domain, endpoint, and model arrays.
 */
export async function resolveCricketApp(app, {
  baseUrl
} = {}) {
  let definedApp = definedAppFor(app);
  let domains = await loadDomains(definedApp.domains, {
    baseUrl: definedApp.baseUrl ?? baseUrl
  });
  let hasExplicitEndpoints = Object.hasOwn(definedApp, 'endpoints');
  let hasExplicitJobs = Object.hasOwn(definedApp, 'jobs');
  let hasExplicitModels = Object.hasOwn(definedApp, 'models');

  return freezeAppContract({
    ...definedApp,
    domains,
    endpoints: flattenRoutes(hasExplicitEndpoints ? definedApp.endpoints : collectEndpoints(domains)),
    jobs: hasExplicitJobs ? definedApp.jobs : collectJobs(domains),
    models: hasExplicitModels ? definedApp.models : collectModels(domains)
  });
}

/**
 * Check whether an app module is being executed directly by Node.
 *
 * @param {string} moduleUrl - Usually `import.meta.url` from the caller.
 * @param {string[]} [argv=process.argv] - Process argv, injected in tests.
 * @returns {boolean} True when the module is the process entrypoint.
 */
export function isMainModule(moduleUrl, argv = process.argv) {
  if (!argv[1])
    return false;

  return moduleUrl === pathToFileURL(path.resolve(argv[1])).href;
}
