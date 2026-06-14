import { applyRules } from './rule.js';
import {
  responseContractFailed,
  unauthenticated,
  validationFailed
} from './errors.js';
import {
  isZodSchema,
  parseZod
} from './schema.js';

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

export function normalizeEndpointMethod(method) {
  let normalized = String(method).toUpperCase();

  if (!supportedEndpointMethodSet.has(normalized))
    throw new Error(`Unsupported endpoint method ${normalized}`);

  return normalized;
}

function parseRequestSchema(schema, value) {
  if (!schema) return value;

  return parseZod(schema, value, validationFailed);
}

function parseRequestObjectSchema(schema, value) {
  return parseRequestSchema(schema, value ?? {});
}

function mergeNormalizedRequest(request, normalized = {}) {
  let inputFields = ['body', 'params', 'query', 'files', 'cookies'];
  let normalizedInput = Object.fromEntries(
    inputFields
      .filter(field => Object.hasOwn(normalized, field))
      .map(field => [field, normalized[field]])
  );

  return {
    ...request,
    ...normalizedInput
  };
}

async function normalizeRequestInput(normalize, request, context) {
  if (!normalize)
    return request;

  let normalized = await normalize(request, context);

  return mergeNormalizedRequest(request, normalized ?? {});
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
  if (isWebResponse(response))
    return response;

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

function isWebResponse(value) {
  return value &&
    typeof value.status === 'number' &&
    typeof value.headers?.forEach === 'function' &&
    typeof value.arrayBuffer === 'function';
}

function parseResponse(schema, value) {
  if (!schema) return value;
  if (!isZodSchema(schema)) return value;

  return parseZod(schema, value, responseContractFailed);
}

function requireAuthenticatedContext(context) {
  if (!context.user && !context.userId)
    throw unauthenticated();
}

/**
 * Enforce an endpoint's auth flag against a resolved request context.
 *
 * @param {object} endpoint
 * @param {object} context
 */
export function assertEndpointAuth(endpoint, context) {
  if (endpoint.auth)
    requireAuthenticatedContext(context);
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
 * This keeps validation, auth, rule execution, and response parsing in one
 * place so routes can stay thin and app-specific logic can stay in the handler.
 *
 * @param {object} config
 * @param {string} config.method
 * @param {string} config.path
 * @param {boolean} [config.auth=false]
 * @param {string} [config.summary]
 * @param {string} [config.description]
 * @param {string[]} [config.tags=[]]
 * @param {string} [config.operationId]
 * @param {Array<Function>} [config.before=[]] - Cricket exchange hooks mounted before the handler.
 * @param {Function} [config.normalize] - Optional request input normalizer. Returned `body`, `params`, `query`, `files`, and `cookies` replace those request fields before validation.
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
 *   auth: boolean,
 *   summary?: string,
 *   description?: string,
 *   tags: string[],
 *   operationId?: string,
 *   before: Array<Function>,
 *   normalize?: Function,
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
export function defineEndpoint({
  method,
  path,
  auth = false,
  summary,
  description,
  tags = [],
  operationId,
  before = [],
  normalize,
  maxBodyBytes,
  rawBody = false,
  body,
  params,
  query,
  response,
  responses,
  rules = [],
  handler
}) {
  if (!method) throw new Error('Endpoint method is required');
  if (!path) throw new Error('Endpoint path is required');
  let normalizedMethod = normalizeEndpointMethod(method);

  if (typeof handler !== 'function')
    throw new Error(`${normalizedMethod} ${path} needs a handler`);

  let endpoint = {
    method: normalizedMethod,
    path,
    auth,
    summary,
    description,
    tags,
    operationId,
    before,
    normalize,
    maxBodyBytes,
    rawBody,
    body,
    params,
    query,
    response,
    responses,
    rules,

    async handle(request, context = {}) {
      assertEndpointAuth(endpoint, context);

      let normalizedRequest = await normalizeRequestInput(normalize, request, context);

      let input = {
        body: parseRequestSchema(body, normalizedRequest.body),
        params: parseRequestObjectSchema(params, normalizedRequest.params),
        query: parseRequestObjectSchema(query, normalizedRequest.query)
      };

      let endpointContext = {
        ...context,
        request: normalizedRequest,
        input
      };

      let ruleResponse = await applyRules(rules, endpointContext);

      if (ruleResponse)
        return parseEndpointResponse(endpoint, ruleResponse);

      return parseEndpointResponse(endpoint, await handler(endpointContext));
    }
  };

  return endpoint;
}

function parseEndpointResponse(endpoint, result) {
  if (isWebResponse(result))
    return result;

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
