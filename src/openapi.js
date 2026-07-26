import { defaultStatusForMethod } from './endpoint.js';
import {
  collectApiVersionFamilies,
  endpointApiVersionFamily,
  endpointVersionContract,
  selectedEndpointApiVersion
} from './api-version.js';
import { isPlainObject } from './immutable.js';
import { operationIdFor } from './route-identity.js';
import {
  isZodSchema,
  toJsonSchema
} from './schema.js';

let JSON_CONTENT_TYPE = 'application/json';

function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function withPathPrefix(path, prefix) {
  if (!prefix) return path;

  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function schemaProperties(schema, source) {
  let jsonSchema = toJsonSchema(schema);

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

function jsonContent(schema) {
  return {
    [JSON_CONTENT_TYPE]: {
      schema
    }
  };
}

function parametersFromSchema(source, schema) {
  return schemaProperties(schema, source).map(parameter => ({
    name: parameter.name,
    in: source,
    required: source === 'path' ? true : parameter.required,
    schema: parameter.schema
  }));
}

function requestBodyFromSchema(schema) {
  let jsonSchema = toJsonSchema(schema);
  if (!jsonSchema) return undefined;

  return {
    required: true,
    content: {
      [JSON_CONTENT_TYPE]: {
        schema: jsonSchema
      }
    }
  };
}

function normalizeResponse(status, response) {
  if (isZodSchema(response) || response?.type || response?.properties) {
    return {
      description: status === '204' ? 'No content' : 'Success',
      content: jsonContent(toJsonSchema(response))
    };
  }

  let description = response?.description ?? (status === '204' ? 'No content' : 'Success');
  let schema = toJsonSchema(response?.schema ?? response?.body);

  return {
    description,
    ...(schema ? {
      content: jsonContent(schema)
    } : {})
  };
}

function responsesForEndpoint(endpoint) {
  if (endpoint.responses) {
    return Object.fromEntries(
      Object.entries(endpoint.responses).map(([status, response]) => [
        status,
        normalizeResponse(status, response)
      ])
    );
  }

  if (endpoint.response) {
    let status = String(defaultStatusForMethod(endpoint.method));

    return {
      [status]: normalizeResponse(status, endpoint.response)
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

  if (Object.hasOwn(response, 'body')) {
    return {
      ...response,
      body: schema
    };
  }

  return {
    ...response,
    schema
  };
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
    let schemaName = `${model.name}${viewName.charAt(0).toUpperCase()}${viewName.slice(1)}`;
    entries.push([schemaName, schema]);
  }

  return entries.filter(([, schema]) => schema);
}

function componentSchemas(models) {
  let schemas = {};

  for (let model of models ?? []) {
    for (let [name, schema] of schemaEntriesForModel(model))
      schemas[name] = toJsonSchema(schema);
  }

  return schemas;
}

function endpointOperation(endpoint, apiVersions) {
  let selection = selectedApiVersion(endpoint, apiVersions);
  let projectedEndpoint = endpointForApiVersion(endpoint, selection);
  let parameters = [
    ...parametersFromSchema('path', projectedEndpoint.params),
    ...parametersFromSchema('query', projectedEndpoint.query),
    apiVersionParameter(selection)
  ].filter(Boolean);
  let requestBody = requestBodyFromSchema(projectedEndpoint.body);
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
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: responsesForEndpoint(projectedEndpoint)
  };
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
 * @returns {object} A plain OpenAPI 3.1 document object with `info`, `paths`, and `components`.
 */
export function generateOpenApi({
  title = 'Cricket API',
  version = '0.0.0',
  description,
  servers = [],
  pathPrefix,
  endpoints = [],
  models = [],
  apiVersions = {}
} = {}) {
  let families = collectApiVersionFamilies(endpoints);
  let familyNames = new Set(families.map(family => family.name));

  for (let familyName of Object.keys(apiVersions)) {
    if (!familyNames.has(familyName))
      throw new Error(`Unknown API version family ${familyName}`);
  }

  let paths = {};
  let schemas = componentSchemas(models);
  let components = {
    ...(Object.keys(schemas).length ? { schemas } : {})
  };

  for (let endpoint of endpoints) {
    let openApiPath = toOpenApiPath(withPathPrefix(endpoint.path, pathPrefix));
    paths[openApiPath] ??= {};
    paths[openApiPath][endpoint.method.toLowerCase()] = endpointOperation(endpoint, apiVersions);
  }

  return {
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
}
