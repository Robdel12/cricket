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

function parseRequestSchema(schema, value) {
  if (!schema) return value;

  return parseZod(schema, value ?? {}, validationFailed);
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

function requireAuthenticatedContext(context) {
  if (!context.user && !context.userId)
    throw unauthenticated();
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
 * @param {Array<Function>} [config.middleware=[]] - Adapter middleware mounted before the Cricket handler.
 * @param {boolean|object} [config.rawBody=false] - Koa adapter option for endpoints that need the unparsed request body.
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
 *   middleware: Array<Function>,
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
  middleware = [],
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
  if (typeof handler !== 'function')
    throw new Error(`${method} ${path} needs a handler`);

  let endpoint = {
    method: method.toUpperCase(),
    path,
    auth,
    summary,
    description,
    tags,
    operationId,
    middleware,
    rawBody,
    body,
    params,
    query,
    response,
    responses,
    rules,

    async handle(request, context = {}) {
      let input = {
        body: parseRequestSchema(body, request.body),
        params: parseRequestSchema(params, request.params),
        query: parseRequestSchema(query, request.query)
      };

      let endpointContext = {
        ...context,
        request,
        input
      };

      if (auth)
        requireAuthenticatedContext(endpointContext);

      let ruleResponse = await applyRules(rules, endpointContext);

      if (ruleResponse)
        return parseEndpointResponse(endpoint, ruleResponse);

      return parseEndpointResponse(endpoint, await handler(endpointContext));
    }
  };

  return endpoint;
}

function parseEndpointResponse(endpoint, result) {
  let response = normalizeResponse(endpoint, result);
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
