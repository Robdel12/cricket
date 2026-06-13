import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export let domainFileTypes = [
  'model',
  'serializers',
  'service',
  'rules',
  'routes'
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

function resolveRootPath(root, baseUrl) {
  if (root instanceof URL)
    return fileURLToPath(root);

  if (path.isAbsolute(root))
    return root;

  let basePath = baseUrl ? path.dirname(fileURLToPath(baseUrl)) : process.cwd();

  return path.resolve(basePath, root);
}

function filePathFor(domainPath, fileStem, type) {
  return path.join(domainPath, `${fileStem}.${type}.js`);
}

async function hasModelFile(domainPath) {
  let fileStem = path.basename(domainPath);

  try {
    await fs.access(filePathFor(domainPath, fileStem, 'model'));
    return true;
  } catch {
    return false;
  }
}

async function importDomainFile(domainPath, fileStem, type) {
  let filePath = filePathFor(domainPath, fileStem, type);

  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Cricket domain ${fileStem} is missing ${path.basename(filePath)}`);
  }

  return await import(pathToFileURL(filePath).href);
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

async function loadDomainFolder(domainPath) {
  let fileStem = path.basename(domainPath);
  let camelName = toCamelCase(fileStem);
  let pascalName = toPascalCase(fileStem);
  let modules = {};

  for (let type of domainFileTypes)
    modules[type] = await importDomainFile(domainPath, fileStem, type);

  let models = collectExported(modules.model, isModelContract);
  let endpoints = collectExported(modules.routes, isEndpointContract);
  let createService = serviceFactoryFor(modules.service, {
    camelName,
    pascalName
  });

  return {
    name: camelName,
    path: domainPath,
    fileStem,
    models,
    endpoints,
    services: {
      [camelName]: createService
    }
  };
}

async function listDomainFolders(rootPath) {
  if (await hasModelFile(rootPath))
    return [rootPath];

  let entries = await fs.readdir(rootPath, {
    withFileTypes: true
  });
  let domainFolders = [];

  for (let entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory())
      continue;

    let folder = path.join(rootPath, entry.name);

    if (await hasModelFile(folder))
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
