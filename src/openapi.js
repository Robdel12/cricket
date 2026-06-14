import {
  isZodSchema,
  toJsonSchema
} from './schema.js';
import { defaultStatusForMethod } from './endpoint.js';

let JSON_CONTENT_TYPE = 'application/json';

function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function withPathPrefix(path, prefix) {
  if (!prefix) return path;

  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function toOperationId(method, path) {
  let pathName = path
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+([A-Za-z0-9])/g, (_, letter) => letter.toUpperCase());

  return `${method.toLowerCase()}${pathName.charAt(0).toUpperCase()}${pathName.slice(1)}`;
}

function schemaProperties(schema) {
  let jsonSchema = toJsonSchema(schema);

  if (!jsonSchema) return [];

  if (jsonSchema.type !== 'object' || !jsonSchema.properties)
    throw new Error('OpenAPI params and query schemas must describe objects');

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
  return schemaProperties(schema).map(parameter => ({
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
    200: {
      description: 'Success'
    }
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

function endpointOperation(endpoint) {
  let parameters = [
    ...parametersFromSchema('path', endpoint.params),
    ...parametersFromSchema('query', endpoint.query)
  ];
  let requestBody = requestBodyFromSchema(endpoint.body);

  return {
    ...(endpoint.summary ? { summary: endpoint.summary } : {}),
    ...(endpoint.description ? { description: endpoint.description } : {}),
    ...(endpoint.tags?.length ? { tags: endpoint.tags } : {}),
    operationId: endpoint.operationId ?? toOperationId(endpoint.method, endpoint.path),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: responsesForEndpoint(endpoint)
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
 * @returns {object} A plain OpenAPI 3.1 document object with `info`, `paths`, and `components`.
 */
export function generateOpenApi({
  title = 'Cricket API',
  version = '0.0.0',
  description,
  servers = [],
  pathPrefix,
  endpoints = [],
  models = []
} = {}) {
  let paths = {};
  let schemas = componentSchemas(models);
  let components = {
    ...(Object.keys(schemas).length ? { schemas } : {})
  };

  for (let endpoint of endpoints) {
    let openApiPath = toOpenApiPath(withPathPrefix(endpoint.path, pathPrefix));
    paths[openApiPath] ??= {};
    paths[openApiPath][endpoint.method.toLowerCase()] = endpointOperation(endpoint);
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
