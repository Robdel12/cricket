import { applyRules } from './rule.js';
import {
  responseContractFailed,
  validationFailed
} from './errors.js';
import {
  isZodSchema,
  parseZod
} from './schema.js';
import { operationIdFor } from './route-identity.js';

export let supportedEndpointMethods = Object.freeze([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT'
]);

let supportedEndpointMethodSet = new Set(supportedEndpointMethods);
let endpointOptionKeys = new Set([
  'method',
  'path',
  'summary',
  'description',
  'tags',
  'operationId',
  'traceName',
  'maxBodyBytes',
  'rawBody',
  'body',
  'params',
  'query',
  'response',
  'responses',
  'rules',
  'handler'
]);

/**
 * Normalize an HTTP method string to uppercase.
 *
 * Throws if the method is not one of Cricket's supported methods.
 *
 * @param {string} method - HTTP method string.
 * @returns {string} Uppercase method name.
 * @throws {Error} When the method is not supported.
 */
export function normalizeEndpointMethod(method) {
  let normalized = String(method).toUpperCase();

  if (!supportedEndpointMethodSet.has(normalized))
    throw new Error(`Unsupported endpoint method ${normalized}`);

  return normalized;
}

function timePhase(timing, name, action) {
  if (!timing)
    return action();

  return timing.time(name, action);
}

function parseRequestSchema(schema, value) {
  if (!schema) return value;

  return parseZod(schema, value, validationFailed);
}

function parseRequestObjectSchema(schema, value) {
  return parseRequestSchema(schema, value ?? {});
}

function responseDefinitionFor(endpoint, status) {
  if (!endpoint.responses)
    return endpoint.response;

  return endpoint.responses[status] ?? endpoint.responses[String(status)];
}

function responseSchemaFrom(definition) {
  if (!definition) return undefined;
  if (isZodSchema(definition)) return definition;

  return definition.schema ?? definition.body;
}

function normalizeResponse(endpoint, response) {
  if (response && typeof response === 'object' && 'status' in response)
    return response;

  if (response && typeof response === 'object' && response.redirect) {
    return {
      status: 303,
      ...response
    };
  }

  return {
    status: defaultStatusForMethod(endpoint.method),
    body: response
  };
}

function parseResponse(schema, value) {
  if (!schema) return value;
  if (!isZodSchema(schema)) return value;

  return parseZod(schema, value, responseContractFailed);
}

function assertKnownEndpointOptions(config) {
  if (!config || typeof config !== 'object')
    throw new Error('Endpoint config is required');

  for (let key of Object.keys(config)) {
    if (!endpointOptionKeys.has(key))
      throw new Error(`Unsupported endpoint option ${key}`);
  }
}

/**
 * Return Cricket's default success status for an HTTP method.
 *
 * Runtime responses and generated OpenAPI docs share this helper so a handler
 * that returns a bare body documents the same status Cricket will send.
 *
 * @param {string} method
 * @returns {number}
 */
export function defaultStatusForMethod(method) {
  return method.toUpperCase() === 'POST' ? 201 : 200;
}

/**
 * Define a request/response contract around a handler.
 *
 * This keeps validation, rule execution, and response parsing in one place so
 * routes can stay thin and app-specific logic can stay in the handler.
 *
 * @param {object} config
 * @param {string} config.method
 * @param {string} config.path
 * @param {string} [config.summary]
 * @param {string} [config.description]
 * @param {string[]} [config.tags=[]]
 * @param {string} [config.operationId]
 * @param {string} [config.traceName] - Optional request trace span name for the handler.
 * @param {number} [config.maxBodyBytes] - Maximum buffered request body size for this endpoint.
 * @param {boolean|object} [config.rawBody=false] - Endpoint option for requests that need the unparsed request body.
 * @param {import('zod').ZodTypeAny} [config.body]
 * @param {import('zod').ZodTypeAny} [config.params]
 * @param {import('zod').ZodTypeAny} [config.query]
 * @param {any} [config.response]
 * @param {Record<string | number, any>} [config.responses]
 * @param {Array<Function>} [config.rules=[]]
 * @param {(context: any) => any|Promise<any>} config.handler
 * @returns {{
 *   method: string,
 *   path: string,
 *   summary?: string,
 *   description?: string,
 *   tags: string[],
 *   operationId?: string,
 *   traceName?: string,
 *   maxBodyBytes?: number,
 *   rawBody?: boolean|object,
 *   body?: any,
 *   params?: any,
 *   query?: any,
 *   response?: any,
 *   responses?: Record<string | number, any>,
 *   rules: Array<Function>,
 *   handle(request: any, context?: any): Promise<{
 *     status: number,
 *     body?: any,
 *     headers?: Record<string, string>,
 *     cookies?: Array<{name: string, value: string, options?: object}>,
 *     redirect?: string,
 *     onClose?: Function
 *   }>
 * }}
 */
export function defineEndpoint(config) {
  assertKnownEndpointOptions(config);

  let {
    method,
    path,
    summary,
    description,
    tags = [],
    operationId,
    traceName,
    maxBodyBytes,
    rawBody = false,
    body,
    params,
    query,
    response,
    responses,
    rules = [],
    handler
  } = config;

  if (!method) throw new Error('Endpoint method is required');
  if (!path) throw new Error('Endpoint path is required');
  let normalizedMethod = normalizeEndpointMethod(method);

  if (typeof handler !== 'function')
    throw new Error(`${normalizedMethod} ${path} needs a handler`);
  if (traceName !== undefined && typeof traceName !== 'string')
    throw new Error(`${normalizedMethod} ${path} traceName must be a string`);

  let endpoint = {
    method: normalizedMethod,
    path,
    summary,
    description,
    tags,
    operationId,
    traceName,
    maxBodyBytes,
    rawBody,
    body,
    params,
    query,
    response,
    responses,
    rules,

    async handle(request, context = {}, {
      timing
    } = {}) {
      let input = await timePhase(timing, 'validationMs', () => ({
        body: parseRequestSchema(body, request.body),
        params: parseRequestObjectSchema(params, request.params),
        query: parseRequestObjectSchema(query, request.query)
      }));

      let endpointContext = {
        ...context,
        request,
        input
      };

      let handlerContext = await timePhase(timing, 'rulesMs', () =>
        applyRules(rules, endpointContext)
      );
      let handlerTraceName = traceName ?? operationIdFor(endpoint);
      let result = await timePhase(timing, 'handlerMs', () => {
        if (typeof handlerContext.trace?.span === 'function')
          return handlerContext.trace.span(handlerTraceName, () => handler(handlerContext));

        return handler(handlerContext);
      });

      return await timePhase(timing, 'responseValidationMs', () =>
        parseEndpointResponse(endpoint, result)
      );
    }
  };

  return endpoint;
}

function parseEndpointResponse(endpoint, result) {
  let response = normalizeResponse(endpoint, result);

  if (response.redirect)
    return response;

  let schema = responseSchemaFrom(
    responseDefinitionFor(endpoint, response.status)
  );

  return {
    ...response,
    body: parseResponse(schema, response.body)
  };
}

/**
 * Mark a handler result as a created resource response.
 *
 * @param {any} body
 * @returns {{ status: number, body: any }}
 */
export function created(body) {
  return {
    status: 201,
    body
  };
}

/**
 * Mark a handler result as a standard success response.
 *
 * @param {any} body
 * @returns {{ status: number, body: any }}
 */
export function ok(body) {
  return {
    status: 200,
    body
  };
}
