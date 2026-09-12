import { defaultStatusForMethod } from './endpoint.js';
import {
  collectApiVersionFamilies,
  endpointApiVersionFamily,
  endpointVersionContract,
  selectedEndpointApiVersion
} from './api-version.js';
import { frozenPlain, isPlainObject } from './immutable.js';
import { operationIdFor } from './route-identity.js';
import {
  isZodSchema,
  toJsonSchema,
  visitJsonSchema
} from './schema.js';

let JSON_CONTENT_TYPE = 'application/json';

function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function withPathPrefix(path, prefix) {
  if (!prefix) return path;

  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function localSchemaTarget(schema, reference) {
  if (reference === '#') return schema;
  if (!reference.startsWith('#/')) return undefined;
  let target = schema;
  for (let part of decodeURIComponent(reference.slice(2)).split('/')) {
    let key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!target || !Object.hasOwn(target, key)) return undefined;
    target = target[key];
  }
  return target;
}

/**
 * Keep each converted Zod schema's local references in its own component.
 * State belongs to one document build; only freshly generated schemas are edited.
 * Explicit OpenAPI references and caller-owned JSON Schema are left alone.
 */
function createSchemaConverter(models) {
  let reservedNames = new Set((models ?? []).flatMap(model =>
    schemaEntriesForModel(model).map(([name]) => name)
  ));
  let schemas = {};
  let nextId = 1;
  function convert(schema, { inline = false, ...options } = {}) {
    let converted = toJsonSchema(schema, options);
    if (!isZodSchema(schema)) return converted;
    let references = [];
    visitJsonSchema(converted, node => {
      if (typeof node.$ref === 'string' && localSchemaTarget(converted, node.$ref) !== undefined)
        references.push(node);
    });
    if (!references.length) return converted;
    let name;
    do { name = `RecursiveSchema${nextId++}`; } while (reservedNames.has(name));
    let root = `#/components/schemas/${name}`;
    for (let node of references) node.$ref = root + node.$ref.slice(1);
    schemas[name] = converted;
    if (!inline) return { $ref: root };
    // Parameters and multipart fields need the object shape, but their references
    // now resolve through the component, so they don't need a second copy of defs.
    let { $defs, definitions, ...shape } = converted;
    return shape;
  }
  return { convert, schemas };
}

function schemaProperties(schema, source, convert) {
  let jsonSchema = convert(schema, { inline: true });

  if (!jsonSchema) return [];

  if (jsonSchema.type !== 'object')
    throw new Error('OpenAPI params and query schemas must describe objects');

  if (!jsonSchema.properties) {
    if (source === 'query')
      return [];

    throw new Error('OpenAPI params and query schemas must describe objects');
  }

  let required = new Set(jsonSchema.required ?? []);

  return Object.entries(jsonSchema.properties).map(([name, property]) => ({
    name,
    required: required.has(name),
    schema: property
  }));
}

function contentForSchema(schema, contentType = JSON_CONTENT_TYPE, example) {
  if (typeof contentType !== 'string' || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType))
    throw new Error('Content type must be a media type without parameters');
  return {
    [contentType]: {
      schema,
      ...(example === undefined ? {} : { example })
    }
  };
}

function parametersFromSchema(source, schema, convert) {
  return schemaProperties(schema, source, convert).map(parameter => ({
    name: parameter.name,
    in: source,
    required: source === 'path' ? true : parameter.required,
    schema: parameter.schema
  }));
}

/**
 * Merge form fields and file parts into one documentation schema.
 * Reject overlapping names and unsupported file-schema keys. This builds a new
 * schema; it doesn't change the inputs or validate uploaded files.
 *
 * @param {object|undefined} schema - Converted form-field schema.
 * @param {object} fileSchema - Zod or JSON Schema describing the file parts.
 * @param {Function} convert - Convert schemas within this document.
 * @returns {object} Combined multipart object schema.
 */
function multipartBodySchema(schema, fileSchema, convert) {
  if (schema && schema.type !== 'object')
    throw new Error('Multipart body schema must describe an object');
  let files = convert(fileSchema, { inline: true });
  if (!files || files.type !== 'object')
    throw new Error('requestBody.files must describe an object of file parts');
  for (let key of Object.keys(files)) {
    if (!['type', 'properties', 'required'].includes(key))
      throw new Error(`requestBody.files only supports type, properties, and required; received ${key}`);
  }
  let overlap = Object.keys(files.properties ?? {}).find(name => Object.hasOwn(schema?.properties ?? {}, name));
  if (overlap) throw new Error(`Multipart file and body field overlap: ${overlap}`);
  return {
    ...schema,
    type: 'object',
    properties: { ...schema?.properties, ...files.properties },
    required: [...(schema?.required ?? []), ...(files.required ?? [])]
  };
}

function requestBodyForEndpoint(endpoint, convert) {
  let metadata = endpoint.requestBody ?? {};
  let schema = convert(metadata.schema ?? endpoint.body, { inline: Boolean(endpoint.multipart) });
  let contentType = metadata.contentType ?? (endpoint.multipart ? 'multipart/form-data' : JSON_CONTENT_TYPE);
  if (metadata.files) {
    if (!endpoint.multipart)
      throw new Error('requestBody.files requires multipart');
    schema = multipartBodySchema(schema, metadata.files, convert);
  }
  if (!schema) {
    if (endpoint.requestBody)
      throw new Error('requestBody documentation needs body, files, or a rawBody schema');
    return undefined;
  }
  if (endpoint.multipart && contentType !== 'multipart/form-data')
    throw new Error('Multipart documentation must use multipart/form-data');
  if (!endpoint.multipart && !endpoint.rawBody && contentType !== JSON_CONTENT_TYPE)
    throw new Error('Non-JSON request documentation requires rawBody');
  return {
    required: metadata.required ?? (endpoint.body?.isOptional ? !endpoint.body.isOptional() : true),
    ...(metadata.description ? { description: metadata.description } : {}),
    content: contentForSchema(schema, contentType, metadata.example)
  };
}

function responseHeaders(headers = {}, convert) {
  if (!isPlainObject(headers)) throw new Error('Response headers must be an object');
  let names = new Set();
  return Object.fromEntries(Object.entries(headers).map(([name, definition]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.toLowerCase() === 'content-type')
      throw new Error(`Invalid documented response header: ${name}`);
    let normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Duplicate response header ${name}`);
    names.add(normalizedName);
    let descriptor = isZodSchema(definition) ? { schema: definition } : definition;
    let schema = convert(descriptor?.schema);
    if (!schema) throw new Error(`Response header ${name} needs a schema`);
    return [name, {
      ...(descriptor.description ? { description: descriptor.description } : {}),
      ...(descriptor.example === undefined ? {} : { example: descriptor.example }),
      schema
    }];
  }));
}

function normalizeResponse(status, response, method, convert) {
  let descriptor = isZodSchema(response) || response?.type || response?.properties
    ? { schema: response }
    : response ?? {};
  if (!/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/.test(status))
    throw new Error(`Invalid response status ${status}`);
  let noBody = method === 'HEAD' || ['204', '205', '304'].includes(status);
  let schema = noBody ? undefined : convert(
    descriptor.serializer?.output ?? descriptor.schema ?? descriptor.body,
    { io: 'output' }
  );
  return {
    description: descriptor.description ?? (noBody ? 'No content' : 'Success'),
    ...(descriptor.headers ? { headers: responseHeaders(descriptor.headers, convert) } : {}),
    ...(schema ? { content: contentForSchema(schema, descriptor.contentType, descriptor.example) } : {})
  };
}

function responsesForEndpoint(endpoint, convert) {
  if (endpoint.responses) {
    return Object.fromEntries(
      Object.entries(endpoint.responses).map(([status, response]) => [
        status,
        normalizeResponse(status, response, endpoint.method, convert)
      ])
    );
  }

  if (endpoint.response) {
    let status = String(defaultStatusForMethod(endpoint.method));

    return {
      [status]: normalizeResponse(status, endpoint.response, endpoint.method, convert)
    };
  }

  return {
    [defaultStatusForMethod(endpoint.method)]: {
      description: 'Success'
    }
  };
}

function responseWithSchema(response, schema) {
  if (!isPlainObject(response) || response.type || response.properties)
    return schema;

  let { example, serializer, ...metadata } = response;
  let key = Object.hasOwn(response, 'body') ? 'body' : 'schema';
  return { ...metadata, [key]: schema };
}

function selectedApiVersion(endpoint, selections) {
  let family = endpointApiVersionFamily(endpoint);

  if (!family)
    return undefined;

  let version = selectedEndpointApiVersion(endpoint, selections);

  return {
    family,
    version,
    contract: endpointVersionContract(endpoint, version)
  };
}

function endpointForApiVersion(endpoint, selection) {
  let contract = selection?.contract;

  if (!contract)
    return endpoint;

  let responses = contract.responses ? {
    ...endpoint.responses,
    ...Object.fromEntries(Object.entries(contract.responses).map(([status, serializer]) => [
      status,
      responseWithSchema(endpoint.responses?.[status], serializer.output)
    ]))
  } : endpoint.responses;

  return {
    ...endpoint,
    body: contract.body?.source ?? endpoint.body,
    requestBody: contract.body && endpoint.requestBody
      ? Object.fromEntries(Object.entries(endpoint.requestBody).filter(([key]) => key !== 'example'))
      : endpoint.requestBody,
    response: contract.response
      ? responseWithSchema(endpoint.response, contract.response.output)
      : endpoint.response,
    responses
  };
}

function apiVersionParameter(selection) {
  if (!selection)
    return undefined;

  let { family, version } = selection;

  return {
    name: family.header,
    in: 'header',
    required: version !== family.default,
    schema: {
      type: 'string',
      enum: [version],
      ...(version === family.default ? { default: family.default } : {})
    },
    'x-cricket-api-version-family': family.name
  };
}

function schemaEntriesForModel(model) {
  let entries = [
    [`${model.name}Public`, model.public]
  ];

  for (let [viewName, schema] of Object.entries(model.views ?? {})) {
    if ((model.privateFields ?? []).some(name => Object.hasOwn(schema.shape ?? {}, name)))
      continue;
    let schemaName = `${model.name}${viewName.charAt(0).toUpperCase()}${viewName.slice(1)}`;
    entries.push([schemaName, schema]);
  }

  return entries.filter(([, schema]) => schema);
}

function componentSchemas(models, convert) {
  let schemas = {};

  for (let model of models ?? []) {
    for (let [name, schema] of schemaEntriesForModel(model)) {
      if (Object.hasOwn(schemas, name)) throw new Error(`Duplicate component schema ${name}`);
      Object.defineProperty(schemas, name, {
        value: convert(schema, { io: 'output' }), enumerable: true
      });
    }
  }

  return schemas;
}

function endpointOperation(endpoint, apiVersions, convert) {
  let selection = selectedApiVersion(endpoint, apiVersions);
  let projectedEndpoint = endpointForApiVersion(endpoint, selection);
  let parameters = [
    ...parametersFromSchema('path', projectedEndpoint.params, convert),
    ...parametersFromSchema('query', projectedEndpoint.query, convert),
    ...parametersFromSchema('header', projectedEndpoint.headers, convert),
    apiVersionParameter(selection)
  ].filter(Boolean);
  let headerNames = new Set();
  for (let parameter of parameters) {
    if (parameter.in !== 'header') continue;
    let name = parameter.name.toLowerCase();
    if (headerNames.has(name)) throw new Error(`Duplicate header parameter ${name}`);
    if (['authorization', 'content-type', 'accept'].includes(name))
      throw new Error(`Describe ${name} through auth or content types, not header parameters`);
    headerNames.add(name);
  }
  let requestBody = requestBodyForEndpoint(projectedEndpoint, convert);
  let deprecation = endpoint.deprecation;

  return {
    ...(endpoint.summary ? { summary: endpoint.summary } : {}),
    ...(endpoint.description ? { description: endpoint.description } : {}),
    ...(endpoint.tags?.length ? { tags: endpoint.tags } : {}),
    ...(deprecation ? {
      deprecated: true,
      'x-cricket-deprecation': deprecation
    } : {}),
    operationId: operationIdFor(endpoint),
    ...(endpoint.auth === undefined ? {} : { security: endpoint.auth }),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: responsesForEndpoint(projectedEndpoint, convert)
  };
}

function validateAuthMethods(schemes) {
  if (!isPlainObject(schemes)) throw new Error('authMethods must be an object');
  for (let [name, scheme] of Object.entries(schemes)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !isPlainObject(scheme))
      throw new Error('Auth methods need named object definitions');
    if (!['http', 'apiKey', 'oauth2', 'openIdConnect', 'mutualTLS'].includes(scheme.type))
      throw new Error(`Unsupported auth method ${name}`);
    if (scheme.type === 'http' && (typeof scheme.scheme !== 'string' || !scheme.scheme.trim()))
      throw new Error(`HTTP auth method ${name} needs scheme`);
    if (scheme.type === 'apiKey' && (typeof scheme.name !== 'string' || !scheme.name.trim() || !['header', 'query', 'cookie'].includes(scheme.in)))
      throw new Error(`API key scheme ${name} needs name and in`);
    if (scheme.type === 'oauth2' && (!isPlainObject(scheme.flows) || !Object.keys(scheme.flows).length))
      throw new Error(`OAuth scheme ${name} needs flows`);
    if (scheme.type === 'oauth2') validateOAuthFlows(name, scheme.flows);
    if (scheme.type === 'openIdConnect' && (typeof scheme.openIdConnectUrl !== 'string' || !scheme.openIdConnectUrl.trim()))
      throw new Error(`OpenID scheme ${name} needs openIdConnectUrl`);
  }
}

function validateOAuthFlows(name, flows) {
  let requiredUrls = {
    implicit: ['authorizationUrl'], password: ['tokenUrl'],
    clientCredentials: ['tokenUrl'], authorizationCode: ['authorizationUrl', 'tokenUrl']
  };
  for (let [type, flow] of Object.entries(flows)) {
    if (!Object.hasOwn(requiredUrls, type) || !isPlainObject(flow))
      throw new Error(`Invalid OAuth flow ${name}.${type}`);
    for (let key of requiredUrls[type]) {
      if (typeof flow[key] !== 'string' || !flow[key].trim())
        throw new Error(`OAuth flow ${name}.${type} needs ${key}`);
    }
    if (!isPlainObject(flow.scopes) || Object.values(flow.scopes).some(value => typeof value !== 'string'))
      throw new Error(`OAuth flow ${name}.${type} needs scope descriptions`);
  }
}

/**
 * Check local schema references against the finished OpenAPI document.
 * Local references must be document JSON pointers; missing targets throw.
 * External references are left alone and never fetched.
 *
 * @param {object} document - Generated OpenAPI document.
 * @returns {void}
 */
function validateSchemaReferences(document) {
  let check = schema => visitJsonSchema(schema, node => {
    if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#')) return;
    if (!node.$ref.startsWith('#/'))
      throw new Error(`OpenAPI schema references must use document JSON pointers: ${node.$ref}`);
    let target = document;
    for (let part of decodeURIComponent(node.$ref.slice(2)).split('/')) {
      let key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!target || !Object.hasOwn(target, key))
        throw new Error(`Unresolved OpenAPI schema reference ${node.$ref}`);
      target = target[key];
    }
  });
  let checkContent = owner => {
    for (let media of Object.values(owner?.content ?? {})) check(media.schema);
  };
  for (let schema of Object.values(document.components?.schemas ?? {})) check(schema);
  for (let path of Object.values(document.paths)) {
    for (let operation of Object.values(path)) {
      for (let parameter of operation.parameters ?? []) check(parameter.schema);
      checkContent(operation.requestBody);
      for (let response of Object.values(operation.responses)) {
        checkContent(response);
        for (let header of Object.values(response.headers ?? {})) check(header.schema);
      }
    }
  }
}

function validateAuthRequirements(requirements, schemes) {
  if (requirements === undefined) return;
  if (!Array.isArray(requirements)) throw new Error('Endpoint auth must be an array');
  for (let requirement of requirements) {
    if (!isPlainObject(requirement)) throw new Error('Auth requirements must be objects');
    for (let [name, scopes] of Object.entries(requirement)) {
      if (!Object.hasOwn(schemes, name)) throw new Error(`Unknown auth method ${name}`);
      if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string'))
        throw new Error(`Auth scopes for ${name} must be strings`);
      if (!['oauth2', 'openIdConnect'].includes(schemes[name].type) && scopes.length)
        throw new Error(`Auth method ${name} does not support scopes`);
    }
  }
}

/**
 * Generates an OpenAPI 3.1 document from Cricket endpoint and model contracts.
 *
 * The generator is intentionally narrow: it translates the framework's own
 * endpoint/model shapes into an OpenAPI document without knowing anything
 * about a specific app layout.
 *
 * @param {object} [options]
 * @param {string} [options.title='Cricket API'] - OpenAPI info title.
 * @param {string} [options.version='0.0.0'] - OpenAPI info version.
 * @param {string} [options.description] - Optional OpenAPI info description.
 * @param {Array<object>} [options.servers=[]] - Optional server entries for the OpenAPI document.
 * @param {string} [options.pathPrefix] - Optional prefix applied before endpoint paths are emitted.
 * @param {Array<object>} [options.endpoints=[]] - Endpoint contracts to translate into path operations.
 * @param {Array<object>} [options.models=[]] - Model contracts used to generate component schemas.
 * @param {Record<string, string>} [options.apiVersions={}] - Exact API version selected for each endpoint family.
 * @param {Record<string, object>} [options.authMethods={}] - Named OpenAPI authentication descriptions; rules enforce access.
 * @returns {object} A frozen OpenAPI 3.1 document object with `info`, `paths`, and `components`.
 */
export function generateOpenApi({
  title = 'Cricket API',
  version = '0.0.0',
  description,
  servers = [],
  pathPrefix,
  endpoints = [],
  models = [],
  apiVersions = {},
  authMethods = {}
} = {}) {
  let families = collectApiVersionFamilies(endpoints);
  let familyNames = new Set(families.map(family => family.name));

  for (let familyName of Object.keys(apiVersions)) {
    if (!familyNames.has(familyName))
      throw new Error(`Unknown API version family ${familyName}`);
  }

  validateAuthMethods(authMethods);
  let paths = {};
  let operations = new Set();
  let routes = new Set();
  let pathNames = new Map();
  let converter = createSchemaConverter(models);
  let schemas = componentSchemas(models, converter.convert);

  for (let endpoint of endpoints) {
    let openApiPath = toOpenApiPath(withPathPrefix(endpoint.path, pathPrefix));
    let normalizedPath = openApiPath.replace(/\{[^}]+\}/g, '{}');
    let routeKey = `${endpoint.method.toUpperCase()} ${normalizedPath}`;
    let operationId = operationIdFor(endpoint);
    if (routes.has(routeKey)) throw new Error(`Duplicate OpenAPI route ${routeKey}`);
    if (operations.has(operationId)) throw new Error(`Duplicate operation ID ${operationId}`);
    if (pathNames.has(normalizedPath) && pathNames.get(normalizedPath) !== openApiPath)
      throw new Error(`Conflicting OpenAPI path parameter names: ${openApiPath}`);
    pathNames.set(normalizedPath, openApiPath);
    routes.add(routeKey);
    operations.add(operationId);
    validateAuthRequirements(endpoint.auth, authMethods);
    if (!Object.hasOwn(paths, openApiPath))
      Object.defineProperty(paths, openApiPath, { value: {}, enumerable: true });
    paths[openApiPath][endpoint.method.toLowerCase()] = endpointOperation(endpoint, apiVersions, converter.convert);
  }

  schemas = { ...schemas, ...converter.schemas };
  let components = {
    ...(Object.keys(schemas).length ? { schemas } : {}),
    ...(Object.keys(authMethods).length ? { securitySchemes: authMethods } : {})
  };
  let document = {
    openapi: '3.1.0',
    info: {
      title,
      version,
      ...(description ? { description } : {})
    },
    ...(servers.length ? { servers } : {}),
    paths,
    ...(Object.keys(components).length ? { components } : {})
  };
  validateSchemaReferences(document);
  return frozenPlain(document);
}
