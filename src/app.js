import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectEndpoints,
  collectJobs,
  collectModels,
  loadDomains
} from './domain.js';
import { flattenRoutes } from './http/router.js';
import { normalizeDatabaseConfig } from './persistence/database.js';

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
 * @returns {object} Normalized Cricket app contract.
 */
export function defineCricketApp(options = {}) {
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

  return {
    ...options,
    domains,
    allowedHosts,
    ...(database === undefined ? {} : { database }),
    prefix,
    trustProxy,
    middleware,
    ...(endpoints === undefined ? {} : { endpoints }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(models === undefined ? {} : { models })
  };
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
  let domains = await loadDomains(app.domains, {
    baseUrl: app.baseUrl ?? baseUrl
  });
  let hasExplicitEndpoints = Object.hasOwn(app, 'endpoints');
  let hasExplicitJobs = Object.hasOwn(app, 'jobs');
  let hasExplicitModels = Object.hasOwn(app, 'models');

  return {
    ...app,
    domains,
    endpoints: flattenRoutes(hasExplicitEndpoints ? app.endpoints : collectEndpoints(domains)),
    jobs: hasExplicitJobs ? app.jobs : collectJobs(domains),
    models: hasExplicitModels ? app.models : collectModels(domains)
  };
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
