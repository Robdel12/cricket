import { isPlainObject } from './immutable.js';
import { assertKnownOptions } from './options.js';

let pluginOptionKeys = new Set([
  'domains',
  'name'
]);
let cricketPluginContract = Symbol('Cricket plugin contract');
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

/**
 * Define an immutable package contribution made from ordinary Cricket domains.
 *
 * Domain containers are copied and frozen while their built contracts, schemas,
 * and functions keep their identities. Cricket does not discover package paths
 * or load plugin migrations.
 *
 * @param {{ name: string, domains: object[] }} options - Plugin descriptor.
 * @returns {object} Stable Cricket plugin descriptor.
 */
export function defineCricketPlugin(options = {}) {
  assertKnownOptions(options, pluginOptionKeys, 'defineCricketPlugin');

  if (typeof options.name !== 'string' || !options.name.trim())
    throw new Error('defineCricketPlugin requires a non-empty name.');

  if (!Array.isArray(options.domains) || options.domains.length === 0)
    throw new Error('defineCricketPlugin requires a non-empty domains array.');

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
    domains: Object.freeze(domains)
  };

  Object.defineProperty(plugin, cricketPluginContract, {
    value: true
  });

  return Object.freeze(plugin);
}

export function isCricketPlugin(plugin) {
  return plugin?.[cricketPluginContract] === true;
}
