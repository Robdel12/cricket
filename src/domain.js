import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isJobContract } from './jobs/define-job.js';
import { isMachineContract } from './machine.js';

/** File suffixes Cricket loads from a domain folder. */
export let domainFileTypes = [
  'model',
  'validations',
  'normalizers',
  'serializers',
  'service',
  'rules',
  'routes',
  'jobs',
  'machine'
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
  let machines = collectModuleContracts(modules.machine, isMachineContract);
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
    machines,
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
 * @guide domains Organize your app
 *
 * Cricket apps share one layout. Once you've seen one, you can find your way around any of them, and so can your coding agent.
 *
 * ## Set up the folders
 *
 * Run `init` in your project.
 *
 * ```sh
 * pnpm exec cricket init .
 * ```
 *
 * You'll get this layout:
 *
 * ```text
 * api/
 *   index.js       your app definition
 *   domains/       features, one folder each
 *   middleware/    request middleware, like reading the signed-in user
 *   services/      shared helpers, like email or storage clients
 *   workers/       background job entrypoints
 *   migrations/    database changes
 *   dev/           local-only tools
 * ```
 *
 * `init` adds a short Cricket block to `AGENTS.md`. It maps the domain files and links to local skills for domains, jobs, machines, observability, and testing.
 *
 * In an existing app, run `pnpm exec cricket init agents .` to add missing guidance. After upgrading Cricket, use `pnpm exec cricket init agents . --force` to refresh it. This replaces edits to the Cricket block and shipped skill files. Your other project notes stay in place.
 *
 * ## Add a domain
 *
 * A domain is a folder of files that change together. Here's the projects domain from the [example app](../examples/projects/):
 *
 * ```text
 * api/domains/projects/
 *   schema.model.js         what a stored project looks like
 *   input.validations.js    what callers can send
 *   output.serializers.js   what the API sends back
 *   domain.service.js       reads and writes
 *   access.rules.js         who can do what
 *   http.routes.js          the endpoints
 *   behavior.test.js        tests through HTTP
 * ```
 *
 * Each file has one job, and the suffix says what it is. Cricket loads files by suffix, so there's nothing to register. Start small and add files when the feature needs them. A domain can also have `*.normalizers.js` for outside data, `*.machine.js` for state, and `*.jobs.js` for background work.
 *
 * Let the CLI make the files for you:
 *
 * ```sh
 * pnpm exec cricket new domain projects api/domains --with model,validations,serializers,service,rules,routes,test
 * ```
 *
 * ## Point the app at your domains
 *
 * The app definition lives in `api/index.js`. Set `baseUrl` so relative paths like `./domains` and `./migrations` work no matter where you run from.
 *
 * <!-- example examples/projects/api/index.js api/index.js -->
 *
 * Services are named after the domain folder. The `projects` folder exports `createProjectsService`, and handlers get it as `services.projects`.
 *
 * ## Check your work
 *
 * ```sh
 * pnpm exec cricket check api/index.js
 * pnpm exec cricket inspect api/index.js
 * ```
 *
 * `check` catches structure problems, like two domains with the same name. `inspect` shows everything Cricket loaded: domains, routes, rules, services, models, jobs, and machines.
 *
 * ## Moving an existing app over
 *
 * Got endpoints that don't fit in domains yet? Set `architecture: 'manual'` and pass `endpoints` directly while you migrate. `check` and `inspect` flag it as migration debt, and you can't mix it with `domains`, so the switch is one clean step when you're ready.
 */
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

/** Collect machine contracts by ID. Duplicate IDs across domains throw. */
export function collectMachines(domains) {
  let machines = new Map();
  for (let domain of domains) {
    for (let machine of toArray(domain.machines)) {
      if (!isMachineContract(machine))
        throw new Error(`Cricket domain ${domain.name} machines must come from defineMachine`);
      if (machines.has(machine.id))
        throw new Error(`Cricket app has duplicate machine id ${machine.id}`);
      machines.set(machine.id, machine);
    }
  }
  return [...machines.values()];
}

/**
 * Build a service registry from domain-owned service factories.
 *
 * @param {Array<object>} domains - Domain modules with `services` or `service`.
 * @param {object} dependencies - App dependencies passed to every service factory.
 * @returns {object} Service registry keyed by service name.
 */
export function createServices(domains, dependencies = {}) {
  let domainServices = domains.map(domain => ({
    domain,
    factories: Object.entries(serviceFactoriesFor(domain))
  }));
  let names = new Map();

  for (let { domain, factories } of domainServices) {
    for (let [name] of factories) {
      if (names.has(name))
        throw new Error(`Cricket service ${name} is provided by both domains ${names.get(name)} and ${domain.name || 'unnamed'}.`);

      names.set(name, domain.name || 'unnamed');
    }
  }

  let services = {};

  for (let { domain, factories } of domainServices) {
    let domainDependencies = typeof dependencies === 'function'
      ? dependencies(domain)
      : dependencies;

    for (let [name, createService] of factories)
      services[name] = createService(domainDependencies);
  }

  return services;
}
