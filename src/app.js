import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectEndpoints,
  collectJobs,
  collectModels,
  loadDomains
} from './domain.js';
import { flattenRoutes } from './http/router.js';
import { normalizeTrustProxy } from './http/proxy.js';
import { collectApiVersionFamilies } from './api-version.js';
import { frozenPlain } from './immutable.js';
import { operationIdFor } from './route-identity.js';
import { assertKnownOptions } from './options.js';
import { normalizeDatabaseConfig } from './persistence/database.js';
import { isCricketPlugin } from './plugin.js';

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
  'plugins',
  'prefix',
  'authMethods',
  'requestPolicy',
  'requestBodyLimits',
  'responseHeaders',
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

function normalizeRequestBodyLimits(requestBodyLimits) {
  if (requestBodyLimits === undefined)
    return undefined;
  if (!requestBodyLimits || typeof requestBodyLimits !== 'object' ||
      Array.isArray(requestBodyLimits) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(requestBodyLimits)))
    throw new Error('defineCricketApp requestBodyLimits must be a plain operation ID map');

  let normalized = Object.create(null);
  for (let [operationId, limits] of Object.entries(requestBodyLimits)) {
    if (!operationId.trim())
      throw new Error('defineCricketApp requestBodyLimits keys must be non-empty operation IDs');
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(limits)))
      throw new Error(`defineCricketApp requestBodyLimits.${operationId} must be a plain object`);
    let unknownKeys = Object.keys(limits).filter(key =>
      !['maxBytes', 'maxFileBytes'].includes(key)
    );
    if (unknownKeys.length)
      throw new Error(
        `defineCricketApp requestBodyLimits.${operationId} has unsupported keys: ${unknownKeys.join(', ')}`
      );
    for (let [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(
          `defineCricketApp requestBodyLimits.${operationId}.${name} must be a positive safe integer`
        );
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)
      throw new Error(
        `defineCricketApp requestBodyLimits.${operationId}.maxBytes must be a positive safe integer`
      );
    normalized[operationId] = limits;
  }
  return frozenPlain(normalized);
}

function validateResolvedRequestBodyLimits(requestBodyLimits, endpoints) {
  if (!requestBodyLimits)
    return;

  let operations = new Map(endpoints.map(endpoint => [operationIdFor(endpoint), endpoint]));
  for (let [operationId, limits] of Object.entries(requestBodyLimits)) {
    let endpoint = operations.get(operationId);
    if (!endpoint)
      throw new Error(
        `defineCricketApp requestBodyLimits references unknown operation ID ${operationId}`
      );
    if (endpoint.fetch || endpoint.rawBody || !endpoint.multipart)
      throw new Error(
        `defineCricketApp requestBodyLimits.${operationId} requires a parsed multipart endpoint`
      );
  }
}

function architectureFor(options) {
  let architecture = options.architecture ?? 'domains';

  if (!appArchitectures.has(architecture))
    throw new Error(`defineCricketApp architecture must be one of: ${[...appArchitectures].join(', ')}`);

  if (architecture === 'manual') {
    if (Object.hasOwn(options, 'plugins'))
      throw new Error('defineCricketApp manual architecture cannot configure plugins. Plugins contribute domains, so use architecture: \'domains\'.');

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
    'models',
    'plugins'
  ]) {
    if (Object.hasOwn(stable, key))
      stable[key] = stableList(stable[key]);
  }

  if (Object.hasOwn(stable, 'authMethods'))
    stable.authMethods = frozenPlain(stable.authMethods);

  stable[definedAppContract] = Object.freeze({
    architecture: stable.architecture,
    domains: stable.domains,
    endpoints: stable.endpoints,
    jobs: stable.jobs,
    models: stable.models,
    plugins: stable.plugins,
    trustProxy: stable.trustProxy,
    requestPolicy: stable.requestPolicy,
    responseHeaders: stable.responseHeaders
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
    'models',
    'plugins',
    'trustProxy',
    'requestPolicy',
    'responseHeaders'
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

function validatePlugins(plugins) {
  if (!Array.isArray(plugins))
    throw new Error('defineCricketApp plugins must be an array of defineCricketPlugin descriptors.');

  let names = new Set();
  let serviceMethods = new Map();

  for (let plugin of plugins) {
    if (!isCricketPlugin(plugin))
      throw new Error('defineCricketApp plugins must contain defineCricketPlugin descriptors.');

    if (names.has(plugin.name))
      throw new Error(`defineCricketApp has duplicate plugin name ${plugin.name}.`);

    names.add(plugin.name);

    for (let [serviceName, methods] of Object.entries(plugin.schema?.services ?? {})) {
      let methodsForService = serviceMethods.get(serviceName) ?? new Map();

      for (let methodName of Object.keys(methods)) {
        if (methodsForService.has(methodName))
          throw new Error(`Cricket plugins ${methodsForService.get(methodName)} and ${plugin.name} both define a schema for services.${serviceName}.${methodName}.`);

        methodsForService.set(methodName, plugin.name);
      }

      serviceMethods.set(serviceName, methodsForService);
    }
  }
}

function validateResolvedDomains(domains) {
  let names = new Set();

  for (let domain of domains) {
    if (!domain?.name)
      continue;

    if (names.has(domain.name))
      throw new Error(`Cricket app has duplicate resolved domain name ${domain.name}.`);

    names.add(domain.name);
  }
}

/**
 * Define the Cricket app contract that CLIs, docs generation, and runtimes all
 * consume. This is intentionally plain data plus setup/context functions.
 *
 * @param {object} options - App contract options.
 * @param {'domains'|'manual'} [options.architecture='domains'] - Manual is a migration escape hatch.
 * @param {string|URL|object[]} [options.domains] - Domain root or inline domains. Required unless architecture is manual.
 * @param {object[]} [options.plugins=[]] - Explicit `defineCricketPlugin` descriptors contributing domains.
 * @param {(request: object) => object} [options.responseHeaders]
 *   Default headers for normalized requests.
 * @param {(input: {request: object}) => object|undefined} [options.requestPolicy]
 *   Early response policy.
 * @param {Record<string, {maxBytes: number, maxFileBytes?: number}>} [options.requestBodyLimits]
 *   Runtime request byte limits keyed by multipart endpoint operation ID.
 * @returns {object} Normalized Cricket app contract.
 */
export function defineCricketApp(options = {}) {
  assertKnownOptions(options, appOptionKeys, 'defineCricketApp');
  if (options.onError !== undefined && typeof options.onError !== 'function')
    throw new Error('defineCricketApp onError must be a function');
  if (options.requestPolicy !== undefined && typeof options.requestPolicy !== 'function')
    throw new Error('defineCricketApp requestPolicy must be a function');
  if (options.responseHeaders !== undefined && typeof options.responseHeaders !== 'function')
    throw new Error('defineCricketApp responseHeaders must be a function');
  let requestBodyLimits = normalizeRequestBodyLimits(options.requestBodyLimits);

  let architecture = architectureFor(options);
  let domains = options.domains ?? [];
  let plugins = options.plugins ?? [];
  validatePlugins(plugins);
  let loadedDomains = hasLoadedDomains(domains);
  let hasExplicitEndpoints = Object.hasOwn(options, 'endpoints');
  let hasExplicitJobs = Object.hasOwn(options, 'jobs');
  let hasExplicitModels = Object.hasOwn(options, 'models');
  let compositionDomains = loadedDomains
    ? [...domains, ...plugins.flatMap(plugin => plugin.domains)]
    : undefined;
  let collectedDomains = compositionDomains ? {
    endpoints: collectEndpoints(compositionDomains),
    jobs: collectJobs(compositionDomains),
    models: collectModels(compositionDomains)
  } : {};
  let endpoints = hasExplicitEndpoints ? options.endpoints : collectedDomains.endpoints;
  let jobs = hasExplicitJobs ? options.jobs : collectedDomains.jobs;
  let models = hasExplicitModels ? options.models : collectedDomains.models;
  let allowedHosts = options.allowedHosts;
  let prefix = options.prefix ?? '';
  let trustProxy = normalizeTrustProxy(options.trustProxy);
  let middleware = options.middleware ?? [];
  let database = normalizeDatabaseConfig(options.database);

  if (endpoints !== undefined)
    collectApiVersionFamilies(flattenRoutes(endpoints));

  let contract = freezeAppContract({
    ...options,
    architecture,
    domains,
    plugins,
    allowedHosts,
    ...(database === undefined ? {} : { database }),
    prefix,
    trustProxy,
    middleware,
    ...(requestBodyLimits === undefined ? {} : { requestBodyLimits }),
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
  domains = [...domains, ...definedApp.plugins.flatMap(plugin => plugin.domains)];
  validateResolvedDomains(domains);
  let hasExplicitEndpoints = Object.hasOwn(definedApp, 'endpoints');
  let hasExplicitJobs = Object.hasOwn(definedApp, 'jobs');
  let hasExplicitModels = Object.hasOwn(definedApp, 'models');

  let endpoints = flattenRoutes(hasExplicitEndpoints ? definedApp.endpoints : collectEndpoints(domains));

  validateResolvedRequestBodyLimits(definedApp.requestBodyLimits, endpoints);

  collectApiVersionFamilies(endpoints);

  return freezeAppContract({
    ...definedApp,
    domains,
    endpoints,
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
