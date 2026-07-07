import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isJobContract } from './jobs/define-job.js';

export let domainFileTypes = [
  'model',
  'validations',
  'normalizers',
  'serializers',
  'service',
  'rules',
  'routes',
  'jobs'
];

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function toWords(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function toCamelCase(value) {
  let [first = '', ...rest] = toWords(value);

  return [
    first.toLowerCase(),
    ...rest.map(word => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
  ].join('');
}

function toPascalCase(value) {
  return toWords(value)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join('');
}

function serviceFactoriesFor(domain) {
  if (domain.services)
    return domain.services;

  if (!domain.service)
    return {};

  if (!domain.name)
    throw new Error('Domain with a single service needs a name');

  return {
    [domain.name]: domain.service
  };
}

function isModelContract(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.parseRow === 'function' &&
    value.name &&
    value.table &&
    value.row;
}

function isEndpointContract(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.handle === 'function' &&
    value.method &&
    value.path;
}

function exportedValues(module) {
  return Object.values(module).flatMap(toArray);
}

function collectExported(module, predicate) {
  return [...new Set(exportedValues(module).filter(predicate))];
}

function collectModuleContracts(modules, predicate) {
  return [...new Set(modules.flatMap(module => collectExported(module, predicate)))];
}

function resolveRootPath(root, baseUrl) {
  if (root instanceof URL)
    return fileURLToPath(root);

  if (path.isAbsolute(root))
    return root;

  let basePath = baseUrl ? path.dirname(fileURLToPath(baseUrl)) : process.cwd();

  return path.resolve(basePath, root);
}

async function domainFilePathsFor(domainPath, type) {
  let entries = await fs.readdir(domainPath, {
    withFileTypes: true
  });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(`.${type}.js`))
    .map(entry => path.join(domainPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function hasDomainFile(domainPath) {
  for (let type of domainFileTypes) {
    let filePaths = await domainFilePathsFor(domainPath, type);

    if (filePaths.length > 0)
      return true;
  }

  return false;
}

async function importDomainFiles(domainPath, type) {
  let modules = [];
  let paths = await domainFilePathsFor(domainPath, type);

  for (let filePath of paths) {
    modules.push(await import(pathToFileURL(filePath).href));
  }

  return modules;
}

function serviceFactoryFor(module, {
  camelName,
  pascalName
}) {
  let namedFactory = module[`create${pascalName}Service`];

  if (typeof namedFactory === 'function')
    return namedFactory;

  if (typeof module.default === 'function')
    return module.default;

  let factories = Object.entries(module)
    .filter(([name, value]) =>
      name.startsWith('create') &&
      name.endsWith('Service') &&
      typeof value === 'function'
    )
    .map(([, value]) => value);

  if (factories.length === 1)
    return factories[0];

  throw new Error(`Cricket domain ${camelName} needs create${pascalName}Service`);
}

function mergeModuleExports(modules, type, {
  camelName
}) {
  let merged = {};

  for (let module of modules) {
    for (let [name, value] of Object.entries(module)) {
      if (Object.hasOwn(merged, name))
        throw new Error(`Cricket domain ${camelName} has duplicate ${type} export ${name}`);

      merged[name] = value;
    }
  }

  return merged;
}

function serviceFactoriesForModules(modules, {
  camelName,
  pascalName
}) {
  if (modules.length === 0)
    return {};

  if (modules.length > 1)
    throw new Error(`Cricket domain ${camelName} can load one service file`);

  return {
    [camelName]: serviceFactoryFor(modules[0], {
      camelName,
      pascalName
    })
  };
}

async function loadDomainFolder(domainPath) {
  let fileStem = path.basename(domainPath);
  let camelName = toCamelCase(fileStem);
  let pascalName = toPascalCase(fileStem);
  let modules = {};

  for (let type of domainFileTypes)
    modules[type] = await importDomainFiles(domainPath, type);

  let models = collectModuleContracts(modules.model, isModelContract);
  let endpoints = collectModuleContracts(modules.routes, isEndpointContract);
  let jobs = collectModuleContracts(modules.jobs, isJobContract);
  let services = serviceFactoriesForModules(modules.service, {
    camelName,
    pascalName
  });

  return {
    name: camelName,
    path: domainPath,
    fileStem,
    models,
    endpoints,
    jobs,
    validations: mergeModuleExports(modules.validations, 'validations', { camelName }),
    normalizers: mergeModuleExports(modules.normalizers, 'normalizers', { camelName }),
    rules: mergeModuleExports(modules.rules, 'rules', { camelName }),
    serializers: mergeModuleExports(modules.serializers, 'serializers', { camelName }),
    services
  };
}

async function listDomainFolders(rootPath) {
  if (await hasDomainFile(rootPath))
    return [rootPath];

  let entries = await fs.readdir(rootPath, {
    withFileTypes: true
  });
  let domainFolders = [];

  for (let entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory())
      continue;

    let folder = path.join(rootPath, entry.name);

    if (await hasDomainFile(folder))
      domainFolders.push(folder);
  }

  return domainFolders;
}

/**
 * Load Cricket domains from the standard folder structure.
 *
 * @param {string|URL|Array<object|string|URL>} domains - Domain root, domain folders, or already-loaded domain objects.
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] - Module URL used to resolve relative domain paths.
 * @returns {Promise<Array<object>>} Loaded domain contracts.
 */
export async function loadDomains(domains = [], {
  baseUrl
} = {}) {
  if (!domains)
    return [];

  if (typeof domains === 'string' || domains instanceof URL) {
    let rootPath = resolveRootPath(domains, baseUrl);
    let folders = await listDomainFolders(rootPath);

    return Promise.all(folders.map(loadDomainFolder));
  }

  return Promise.all(toArray(domains).map(domain => {
    if (typeof domain === 'string' || domain instanceof URL)
      return loadDomainFolder(resolveRootPath(domain, baseUrl));

    return domain;
  }));
}

/**
 * Collect endpoint contracts from plain domain modules.
 *
 * @param {Array<object>} domains - Domain modules with `endpoints` or `endpoint`.
 * @returns {Array<object>} Flattened endpoint list.
 */
export function collectEndpoints(domains) {
  return domains.flatMap(domain =>
    toArray(domain.endpoints ?? domain.endpoint)
  );
}

/**
 * Collect model contracts from plain domain modules.
 *
 * @param {Array<object>} domains - Domain modules with `models` or `model`.
 * @returns {Array<object>} Flattened model list.
 */
export function collectModels(domains) {
  return domains.flatMap(domain =>
    toArray(domain.models ?? domain.model)
  );
}

/**
 * Collect job contracts from plain domain modules.
 *
 * @param {Array<object>} domains - Domain modules with `jobs` or `job`.
 * @returns {Array<object>} Flattened job list.
 */
export function collectJobs(domains) {
  return domains.flatMap(domain =>
    toArray(domain.jobs ?? domain.job).filter(isJobContract)
  );
}

/**
 * Build a service registry from domain-owned service factories.
 *
 * @param {Array<object>} domains - Domain modules with `services` or `service`.
 * @param {object} dependencies - App dependencies passed to every service factory.
 * @returns {object} Service registry keyed by service name.
 */
export function createServices(domains, dependencies = {}) {
  let services = {};

  for (let domain of domains) {
    let domainDependencies = typeof dependencies === 'function'
      ? dependencies(domain)
      : dependencies;

    for (let [name, createService] of Object.entries(serviceFactoriesFor(domain)))
      services[name] = createService(domainDependencies);
  }

  return services;
}
