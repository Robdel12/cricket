import { badRequest } from './errors.js';
import {
  frozenPlain,
  isPlainObject
} from './immutable.js';
import { assertKnownOptions } from './options.js';
import { withResponseHeaders } from './response.js';
import { singleHeaderValue } from './http/request.js';

let apiVersionContractKind = Symbol('cricket.apiVersionContract');
let familyOptionKeys = new Set([
  'clientHeader',
  'current',
  'default',
  'header',
  'name',
  'versions'
]);
let versionMetadataKeys = new Set([
  'deprecatedAt',
  'sunsetAt'
]);
let endpointVersionKeys = new Set([
  'body',
  'response',
  'responses'
]);

function hasVersion(family, version) {
  return Object.hasOwn(family.versions, version);
}

function nonEmptyString(value, message) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(message);

  return value;
}

function normalizedHeaderName(value, name) {
  let header = nonEmptyString(value, `${name} must be a non-empty string`).trim();

  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
    throw new Error(`${name} must be a valid HTTP header name`);

  return header;
}

function normalizedVersion(value, message) {
  let version = nonEmptyString(value, message);

  if (version.length > 128 || /[\s,\x00-\x1F\x7F]/.test(version))
    throw new Error(message);

  return version;
}

function normalizedDate(value, name) {
  if (value === undefined)
    return undefined;

  let date = new Date(value);

  if (Number.isNaN(date.getTime()))
    throw new Error(`${name} must be a valid date`);

  return date.toISOString();
}

function normalizedVersions(versions, familyName) {
  if (!isPlainObject(versions))
    throw new Error(`API version family ${familyName} needs versions`);

  let entries = Object.entries(versions);

  if (!entries.length)
    throw new Error(`API version family ${familyName} needs at least one version`);

  return frozenPlain(Object.fromEntries(entries.map(([version, metadata = {}]) => {
    let normalized = normalizedVersion(
      version,
      `API version family ${familyName} has an invalid version`
    );

    if (!isPlainObject(metadata))
      throw new Error(`API version ${version} metadata must be a plain object`);

    assertKnownOptions(metadata, versionMetadataKeys, `API version ${version}`);

    return [normalized, {
      ...(metadata.deprecatedAt === undefined ? {} : {
        deprecatedAt: normalizedDate(metadata.deprecatedAt, `API version ${version} deprecatedAt`)
      }),
      ...(metadata.sunsetAt === undefined ? {} : {
        sunsetAt: normalizedDate(metadata.sunsetAt, `API version ${version} sunsetAt`)
      })
    }];
  })));
}

function assertNormalizer(normalizer, familyName, version) {
  if (
    typeof normalizer !== 'function' ||
    !normalizer.normalizerName ||
    !normalizer.source ||
    !normalizer.output
  ) {
    throw new Error(`API version ${familyName} ${version} body must be a Cricket normalizer`);
  }
}

function assertSerializer(serializer, familyName, version, label) {
  if (
    typeof serializer !== 'function' ||
    !serializer.serializerName ||
    !serializer.output
  ) {
    throw new Error(`API version ${familyName} ${version} ${label} must be a Cricket serializer`);
  }
}

function normalizedEndpointVersions(family, overrides) {
  if (!isPlainObject(overrides))
    throw new Error(`API version family ${family.name} endpoint versions must be a plain object`);

  let entries = Object.entries(overrides);

  return frozenPlain(Object.fromEntries(entries.map(([version, contract]) => {
    if (!hasVersion(family, version))
      throw new Error(`Unknown ${family.name} API version ${version}`);
    if (version === family.current)
      throw new Error(`Current API version ${family.name} ${version} uses the endpoint base contract`);
    if (!isPlainObject(contract))
      throw new Error(`API version ${family.name} ${version} endpoint contract must be a plain object`);

    assertKnownOptions(contract, endpointVersionKeys, `API version ${family.name} ${version} endpoint contract`);

    if (contract.body)
      assertNormalizer(contract.body, family.name, version);
    if (contract.response)
      assertSerializer(contract.response, family.name, version, 'response');
    if (contract.response && contract.responses)
      throw new Error(`API version ${family.name} ${version} cannot define response and responses together`);
    if (contract.responses) {
      if (!isPlainObject(contract.responses))
        throw new Error(`API version ${family.name} ${version} responses must be a plain object`);

      for (let [status, serializer] of Object.entries(contract.responses))
        assertSerializer(serializer, family.name, version, `response ${status}`);
    }

    return [version, contract];
  })));
}

/**
 * Define one immutable API version family that endpoints can opt into.
 *
 * The returned function binds historical compatibility deltas to an endpoint.
 * Current request and response schemas remain the endpoint's normal base contract.
 *
 * @param {object} options
 * @returns {Function}
 */
export function defineApiVersions(options = {}) {
  assertKnownOptions(options, familyOptionKeys, 'defineApiVersions');

  let name = nonEmptyString(options.name, 'API version family name is required').trim();

  if (name.length > 128 || /[\x00-\x1F\x7F]/.test(name))
    throw new Error('API version family name is invalid');

  let header = normalizedHeaderName(options.header, `API version family ${name} header`);
  let clientHeader = options.clientHeader === undefined
    ? undefined
    : normalizedHeaderName(options.clientHeader, `API version family ${name} clientHeader`);
  let versions = normalizedVersions(options.versions, name);
  let current = normalizedVersion(options.current, `API version family ${name} current is required`);
  let defaultVersion = normalizedVersion(options.default, `API version family ${name} default is required`);

  if (!Object.hasOwn(versions, current))
    throw new Error(`API version family ${name} current must be supported`);
  if (!Object.hasOwn(versions, defaultVersion))
    throw new Error(`API version family ${name} default must be supported`);

  let family = Object.freeze({
    name,
    header,
    clientHeader,
    current,
    default: defaultVersion,
    versions
  });

  let bindEndpoint = (overrides = {}) => {
    let contract = {
      family,
      versions: normalizedEndpointVersions(family, overrides)
    };

    Object.defineProperty(contract, apiVersionContractKind, {
      value: true
    });

    return Object.freeze(contract);
  };

  return Object.freeze(bindEndpoint);
}

export function isApiVersionContract(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    Object.hasOwn(value, apiVersionContractKind) &&
    value[apiVersionContractKind] === true;
}

export function endpointApiVersionFamily(endpoint) {
  return endpoint?.apiVersions?.family;
}

function clientVersionFrom(request, header) {
  if (!header)
    return undefined;

  let value;

  try {
    value = singleHeaderValue(request, header, {
      ambiguousMessage: `Ambiguous ${header} header`,
      rejectCommaSeparated: true
    });
  } catch {
    return undefined;
  }

  if (!value || value.length > 64 || !/^[A-Za-z0-9._+-]+$/.test(value))
    return undefined;

  return value;
}

export function resolveEndpointApiVersion(endpoint, request) {
  let contract = endpoint?.apiVersions;

  if (!contract)
    return undefined;

  let { family } = contract;
  let requested = singleHeaderValue(request, family.header, {
    ambiguousMessage: `Ambiguous ${family.header} header`,
    rejectCommaSeparated: true
  });
  let version = requested ?? family.default;

  if (!hasVersion(family, version))
    throw badRequest('Unsupported API version', {
      reason: 'unsupported_api_version'
    });

  return Object.freeze({
    family: family.name,
    version,
    source: requested === undefined ? 'default' : 'header',
    clientVersion: clientVersionFrom(request, family.clientHeader),
    ...family.versions[version]
  });
}

export function apiVersionLogMetadata(negotiation) {
  if (!negotiation)
    return {};

  return {
    apiVersionFamily: negotiation.family,
    apiVersion: negotiation.version,
    apiVersionSource: negotiation.source,
    ...(negotiation.clientVersion ? {
      clientVersion: negotiation.clientVersion
    } : {})
  };
}

export function endpointVersionContract(endpoint, version) {
  let versions = endpoint?.apiVersions?.versions;

  if (!versions || !Object.hasOwn(versions, version))
    return undefined;

  return versions[version];
}

export function selectedEndpointApiVersion(endpoint, selections = {}) {
  let family = endpointApiVersionFamily(endpoint);

  if (!family)
    return undefined;

  let version = Object.hasOwn(selections, family.name)
    ? selections[family.name]
    : family.default;

  if (!hasVersion(family, version))
    throw new Error(`Unknown ${family.name} API version ${version}`);

  return version;
}

export function collectApiVersionFamilies(endpoints = []) {
  let families = new Map();

  for (let endpoint of endpoints) {
    let family = endpointApiVersionFamily(endpoint);

    if (!family)
      continue;

    let existing = families.get(family.name);

    if (existing && existing !== family)
      throw new Error(`API version family ${family.name} must reuse one defineApiVersions definition`);

    families.set(family.name, family);
  }

  return Object.freeze([...families.values()]);
}

function withoutHeader(headers, name) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([headerName]) =>
    headerName.toLowerCase() !== name.toLowerCase()
  ));
}

function withHeader(headers, name, value) {
  return {
    ...withoutHeader(headers, name),
    [name]: value
  };
}

function withVary(headers, name) {
  let values = Object.entries(headers)
    .filter(([headerName]) => headerName.toLowerCase() === 'vary')
    .flatMap(([, value]) => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);

  if (values.includes('*'))
    return withHeader(headers, 'Vary', '*');

  if (!values.some(value => value.toLowerCase() === name.toLowerCase()))
    values.push(name);

  return withHeader(headers, 'Vary', values.join(', '));
}

export function applyApiVersionHeaders(response, endpoint, negotiation) {
  let family = endpointApiVersionFamily(endpoint);

  if (!family)
    return response;

  let headers = withVary(response.headers ?? {}, family.header);

  if (!negotiation)
    return withResponseHeaders(response, headers);

  headers = withHeader(headers, family.header, negotiation.version);

  if (negotiation.deprecatedAt)
    headers = withHeader(
      headers,
      'Deprecation',
      `@${Math.floor(new Date(negotiation.deprecatedAt).getTime() / 1000)}`
    );
  if (negotiation.sunsetAt)
    headers = withHeader(headers, 'Sunset', new Date(negotiation.sunsetAt).toUTCString());

  return withResponseHeaders(response, headers);
}
