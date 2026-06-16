import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectEndpoints,
  collectModels,
  loadDomains
} from './domain.js';
import { flattenRoutes } from './http/router.js';

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
  let hasExplicitModels = Object.hasOwn(options, 'models');
  let endpoints = hasExplicitEndpoints
    ? options.endpoints
    : (loadedDomains ? collectEndpoints(domains) : undefined);
  let models = hasExplicitModels
    ? options.models
    : (loadedDomains ? collectModels(domains) : undefined);
  let allowedHosts = options.allowedHosts;
  let prefix = options.prefix ?? '';
  let trustProxy = options.trustProxy ?? false;
  let middleware = options.middleware ?? [];

  return {
    ...options,
    domains,
    allowedHosts,
    prefix,
    trustProxy,
    middleware,
    ...(endpoints === undefined ? {} : { endpoints }),
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

  return {
    ...app,
    domains,
    endpoints: flattenRoutes(
      Object.hasOwn(app, 'endpoints') ? app.endpoints : collectEndpoints(domains)
    ),
    models: Object.hasOwn(app, 'models') ? app.models : collectModels(domains)
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
