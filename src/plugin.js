import { pluginSchemaFailed } from './errors.js';
import { isPlainObject } from './immutable.js';
import { assertKnownOptions } from './options.js';
import { isZodSchema, parseZod } from './schema.js';

let pluginOptionKeys = new Set([
  'domains',
  'name',
  'schema'
]);
let pluginSchemaOptionKeys = new Set(['services']);
let adapterSchemaOptionKeys = new Set(['input', 'output']);
let cricketPluginContract = Symbol('Cricket plugin contract');
let cricketPluginSchemaContract = Symbol('Cricket plugin schema contract');
let domainMapKeys = new Set([
  'normalizers',
  'rules',
  'serializers',
  'services',
  'validations'
]);

function snapshotExportMap(exports) {
  let snapshot = {};

  for (let [name, value] of Object.entries(exports))
    Object.defineProperty(snapshot, name, {
      value: Array.isArray(value) ? Object.freeze([...value]) : value,
      enumerable: true
    });

  return Object.freeze(snapshot);
}

function snapshotDomain(domain) {
  let snapshot = {};

  for (let [key, value] of Object.entries(domain)) {
    let stableValue = value;

    if (key === 'name' && typeof value === 'string')
      stableValue = value.trim();
    else if (Array.isArray(value))
      stableValue = Object.freeze([...value]);
    else if (domainMapKeys.has(key) && isPlainObject(value))
      stableValue = snapshotExportMap(value);

    Object.defineProperty(snapshot, key, {
      value: stableValue,
      enumerable: true
    });
  }

  return Object.freeze(snapshot);
}

function pluginServiceSchemasFor(services) {
  if (!isPlainObject(services) || Object.keys(services).length === 0)
    throw new Error('definePluginSchema services must be a non-empty object of service contracts.');

  let snapshots = {};

  for (let [serviceName, methods] of Object.entries(services)) {
    if (!serviceName.trim())
      throw new Error('definePluginSchema service names must be non-empty.');

    if (!isPlainObject(methods) || Object.keys(methods).length === 0)
      throw new Error(`definePluginSchema service ${serviceName} must define at least one method.`);

    let methodSnapshots = {};

    for (let [methodName, contract] of Object.entries(methods)) {
      if (!methodName.trim())
        throw new Error(`definePluginSchema service ${serviceName} has an empty method name.`);

      if (!isPlainObject(contract))
        throw new Error(`definePluginSchema ${serviceName}.${methodName} must be a plain object.`);

      assertKnownOptions(contract, adapterSchemaOptionKeys, `definePluginSchema ${serviceName}.${methodName}`);

      if (!isZodSchema(contract.input))
        throw new Error(`definePluginSchema ${serviceName}.${methodName} needs an input Zod schema.`);

      if (!isZodSchema(contract.output))
        throw new Error(`definePluginSchema ${serviceName}.${methodName} needs an output Zod schema.`);

      Object.defineProperty(methodSnapshots, methodName, {
        value: Object.freeze({
          input: contract.input,
          output: contract.output
        }),
        enumerable: true
      });
    }

    Object.defineProperty(snapshots, serviceName, {
      value: Object.freeze(methodSnapshots),
      enumerable: true
    });
  }

  return Object.freeze(snapshots);
}

/**
 * Define the Zod contracts that an app's service adapters must follow.
 *
 * Each method accepts one input value and returns one output value.
 *
 * @param {{ services: Record<string, Record<string, { input: object, output: object }>> }} options
 * @returns {object} Stable plugin service schema.
 */
export function definePluginSchema(options = {}) {
  assertKnownOptions(options, pluginSchemaOptionKeys, 'definePluginSchema');

  let schema = {
    services: pluginServiceSchemasFor(options.services)
  };

  Object.defineProperty(schema, cricketPluginSchemaContract, {
    value: true
  });

  return Object.freeze(schema);
}

export function isPluginSchema(schema) {
  return schema?.[cricketPluginSchemaContract] === true;
}

/**
 * Bind plugin service schemas to app-provided service methods.
 *
 * @param {object[]} plugins
 * @param {object} services
 * @returns {object} Services with validated plugin adapter methods.
 */
export function bindPluginServices(plugins, services) {
  let contracts = new Map();

  for (let plugin of plugins) {
    for (let [serviceName, methods] of Object.entries(plugin.schema?.services ?? {})) {
      let serviceContracts = contracts.get(serviceName) ?? new Map();

      for (let [methodName, contract] of Object.entries(methods)) {
        serviceContracts.set(methodName, {
          pluginName: plugin.name,
          ...contract
        });
      }

      contracts.set(serviceName, serviceContracts);
    }
  }

  if (contracts.size === 0)
    return services;

  if (!isPlainObject(services))
    throw new Error('Cricket plugin schemas require the app service registry to be a plain object.');

  let boundServices = { ...services };

  for (let [serviceName, methods] of contracts) {
    let service = Object.hasOwn(services, serviceName) ? services[serviceName] : undefined;

    if (!isPlainObject(service))
      throw new Error(`Cricket plugin schema requires app service ${serviceName}.`);

    let boundService = { ...service };

    for (let [methodName, contract] of methods) {
      let implementation = Object.hasOwn(service, methodName) ? service[methodName] : undefined;

      if (typeof implementation !== 'function')
        throw new Error(`Cricket plugin ${contract.pluginName} schema requires services.${serviceName}.${methodName} to be a function.`);

      Object.defineProperty(boundService, methodName, {
        value: async function validatePluginService(input) {
          let parsedInput = parseZod(contract.input, input, error =>
            pluginSchemaFailed(contract.pluginName, serviceName, methodName, 'input', error)
          );
          let result = await implementation(parsedInput);

          return parseZod(contract.output, result, error =>
            pluginSchemaFailed(contract.pluginName, serviceName, methodName, 'output', error)
          );
        },
        enumerable: true,
        configurable: true,
        writable: true
      });
    }

    Object.defineProperty(boundServices, serviceName, {
      value: boundService,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  return boundServices;
}

/**
 * Define an immutable package contribution made from ordinary Cricket domains.
 *
 * Domain containers are copied and frozen while their built contracts, schemas,
 * and functions keep their identities. Cricket does not discover package paths
 * or load plugin migrations.
 *
 * @param {{ name: string, domains: object[], schema?: object }} options - Plugin descriptor.
 * @returns {object} Stable Cricket plugin descriptor.
 */
export function defineCricketPlugin(options = {}) {
  assertKnownOptions(options, pluginOptionKeys, 'defineCricketPlugin');

  if (typeof options.name !== 'string' || !options.name.trim())
    throw new Error('defineCricketPlugin requires a non-empty name.');

  if (!Array.isArray(options.domains) || options.domains.length === 0)
    throw new Error('defineCricketPlugin requires a non-empty domains array.');

  if (options.schema !== undefined && !isPluginSchema(options.schema))
    throw new Error('defineCricketPlugin schema must be a definePluginSchema contract.');

  let names = new Set();
  let domains = options.domains.map((domain, index) => {
    if (!isPlainObject(domain))
      throw new Error(`defineCricketPlugin domain ${index + 1} must be a plain object.`);

    if (typeof domain.name !== 'string' || !domain.name.trim())
      throw new Error(`defineCricketPlugin domain ${index + 1} needs a non-empty name.`);

    let name = domain.name.trim();

    if (names.has(name))
      throw new Error(`defineCricketPlugin has duplicate domain name ${name}.`);

    names.add(name);
    return snapshotDomain(domain);
  });
  let plugin = {
    name: options.name.trim(),
    domains: Object.freeze(domains),
    ...(options.schema ? { schema: options.schema } : {})
  };

  Object.defineProperty(plugin, cricketPluginContract, {
    value: true
  });

  return Object.freeze(plugin);
}

export function isCricketPlugin(plugin) {
  return plugin?.[cricketPluginContract] === true;
}
