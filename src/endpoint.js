import { applyRules } from './rule.js';
import {
  endpointVersionContract,
  isApiVersionContract,
  resolveEndpointApiVersion
} from './api-version.js';
import {
  normalizerContractFailed,
  responseContractFailed,
  validationFailed
} from './errors.js';
import { frozenPlain } from './immutable.js';
import {
  isZodSchema,
  parseZod
} from './schema.js';
import { operationIdFor } from './route-identity.js';
import {
  resolveHttpResponse,
  withResponseBody
} from './response.js';

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
  'multipart',
  'rawBody',
  'apiVersions',
  'body',
  'params',
  'query',
  'headers',
  'security',
  'requestBody',
  'response',
  'responses',
  'beforeBodyRules',
  'rules',
  'handler'
]);
let deprecationOptionKeys = new Set([
  'since',
  'sunset',
  'replacement',
  'reason',
  'headers'
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

function parseResponse(schema, value) {
  if (!schema) return value;
  if (!isZodSchema(schema)) return value;

  return parseZod(schema, value, responseContractFailed);
}

function assertApiVersions(apiVersions, method, path, {
  body,
  response,
  responses
}) {
  if (apiVersions === undefined)
    return;

  if (!isApiVersionContract(apiVersions))
    throw new Error(`${method} ${path} apiVersions must come from defineApiVersions`);

  for (let [version, contract] of Object.entries(apiVersions.versions)) {
    if (contract.body && !body)
      throw new Error(`${method} ${path} API version ${version} body needs a current body contract`);
    if (contract.body && contract.body.output !== body)
      throw new Error(`${method} ${path} API version ${version} normalizer output must be the endpoint body schema`);
    if ((contract.response || contract.responses) && !response && !responses)
      throw new Error(`${method} ${path} API version ${version} response needs a current response contract`);
    if (responses && contract.response)
      throw new Error(`${method} ${path} API version ${version} must use status-specific responses`);
    if (response && contract.responses)
      throw new Error(`${method} ${path} API version ${version} must use one response serializer`);
    if (contract.response && !isZodSchema(responseSchemaFrom(response)))
      throw new Error(`${method} ${path} API version ${version} needs a current Zod response schema`);
    for (let status of Object.keys(contract.responses ?? {})) {
      if (!Object.hasOwn(responses ?? {}, status))
        throw new Error(`${method} ${path} API version ${version} response ${status} needs a current response contract`);
      if (!isZodSchema(responseSchemaFrom(responses[status])))
        throw new Error(`${method} ${path} API version ${version} response ${status} needs a current Zod response schema`);
    }
  }
}

function requestBodyForVersion(body, versionContract, request, context) {
  if (versionContract?.body) {
    let normalized = versionContract.body(request.body, context);
    if (normalized === null || normalized === undefined)
      throw normalizerContractFailed({});
    return normalized;
  }

  return parseRequestSchema(body, request.body);
}

function responseSerializerFor(versionContract, status) {
  if (!versionContract)
    return undefined;

  if (versionContract.responses)
    return versionContract.responses[status];

  return versionContract.response;
}

function assertKnownEndpointOptions(config) {
  if (!config || typeof config !== 'object')
    throw new Error('Endpoint config is required');

  for (let key of Object.keys(config)) {
    if (!endpointOptionKeys.has(key))
      throw new Error(`Unsupported endpoint option ${key}`);
  }
}

function assertKnownDeprecationOptions(deprecation) {
  for (let key of Object.keys(deprecation)) {
    if (!deprecationOptionKeys.has(key))
      throw new Error(`Unsupported endpoint deprecation option ${key}`);
  }
}

function normalizedDeprecationText(value, name) {
  if (value === undefined)
    return undefined;

  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Endpoint deprecation ${name} must be a non-empty string`);

  return value;
}

function normalizedDeprecationHeaders(value) {
  if (value === undefined)
    return undefined;

  if (typeof value !== 'boolean')
    throw new Error('Endpoint deprecation headers must be a boolean');

  return value;
}

/**
 * Normalize the optional successor route for docs, inspect output, and optional headers.
 *
 * Strings are kept as user-facing text. Object replacements stay structured so
 * generated surfaces can show method/path/operationId without parsing prose.
 *
 * @param {string|{ method?: string, path?: string, operationId?: string }} replacement
 * @returns {string|{ method?: string, path?: string, operationId?: string }|undefined}
 */
function normalizedReplacement(replacement) {
  if (replacement === undefined)
    return undefined;

  if (typeof replacement === 'string')
    return normalizedDeprecationText(replacement, 'replacement');

  if (!replacement || typeof replacement !== 'object')
    throw new Error('Endpoint deprecation replacement must be a string or object');

  let {
    method,
    path,
    operationId
  } = replacement;

  if (method !== undefined && typeof method !== 'string')
    throw new Error('Endpoint deprecation replacement method must be a string');
  if (path !== undefined && typeof path !== 'string')
    throw new Error('Endpoint deprecation replacement path must be a string');
  if (operationId !== undefined && typeof operationId !== 'string')
    throw new Error('Endpoint deprecation replacement operationId must be a string');
  if (!method && !path && !operationId)
    throw new Error('Endpoint deprecation replacement must name a method, path, or operationId');

  return {
    ...(method ? { method: normalizeEndpointMethod(method) } : {}),
    ...(path ? { path } : {}),
    ...(operationId ? { operationId } : {})
  };
}

/**
 * Normalize endpoint deprecation metadata into Cricket's public contract shape.
 *
 * A plain string is treated as the deprecation reason. Object input keeps only
 * the fields Cricket knows how to project into OpenAPI, inspect, observability,
 * and optional response headers.
 *
 * @param {string|object} deprecation
 * @returns {{ since?: string, sunset?: string, replacement?: string|object, reason?: string, headers?: boolean }}
 */
function normalizeDeprecation(deprecation) {
  if (typeof deprecation === 'string') {
    return {
      reason: normalizedDeprecationText(deprecation, 'reason')
    };
  }

  if (!deprecation || typeof deprecation !== 'object')
    throw new Error('Endpoint deprecation must be a string or object');

  assertKnownDeprecationOptions(deprecation);

  let normalized = {
    since: normalizedDeprecationText(deprecation.since, 'since'),
    sunset: normalizedDeprecationText(deprecation.sunset, 'sunset'),
    replacement: normalizedReplacement(deprecation.replacement),
    reason: normalizedDeprecationText(deprecation.reason, 'reason'),
    headers: normalizedDeprecationHeaders(deprecation.headers)
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  );
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

function assertHttpDocumentation({ headers, requestBody, rawBody, multipart, security }) {
  if (headers !== undefined) {
    if (!isZodSchema(headers) || !headers.shape)
      throw new Error('Endpoint headers must be a Zod object with named lowercase headers');
    for (let name of Object.keys(headers.shape)) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))
        throw new Error('Endpoint header names must be lowercase HTTP header names');
      if (['authorization', 'content-type', 'accept'].includes(name))
        throw new Error(`Describe ${name} through security or content types, not header parameters`);
    }
  }
  if (requestBody !== undefined) {
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody))
      throw new Error('Endpoint requestBody must be a documentation object');
    for (let key of Object.keys(requestBody)) {
      if (!['description', 'contentType', 'example', 'files', 'schema', 'required'].includes(key))
        throw new Error(`Unsupported requestBody option ${key}`);
    }
    if (requestBody.required !== undefined && typeof requestBody.required !== 'boolean')
      throw new Error('requestBody.required must be a boolean');
    if (requestBody.description !== undefined && typeof requestBody.description !== 'string')
      throw new Error('requestBody.description must be a string');
    if (requestBody.schema && !rawBody)
      throw new Error('requestBody.schema is only for rawBody; normal requests use body');
    if (requestBody.files && !multipart)
      throw new Error('requestBody.files requires multipart');
  }
  if (security !== undefined && !Array.isArray(security))
    throw new Error('Endpoint security must be an array of requirements');
}

function parseRequestHeaders(schema, headers = {}) {
  let selected = Object.fromEntries(
    Object.keys(schema.shape)
      .filter(name => Object.hasOwn(headers, name))
      .map(name => [name, headers[name]])
  );
  return parseRequestObjectSchema(schema, selected);
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
 * @param {boolean|object} [config.multipart=false] - Parse multipart form data for this endpoint.
 * @param {boolean|object} [config.rawBody=false] - Endpoint option for requests that need the unparsed request body.
 * @param {object} [config.apiVersions] - Optional endpoint version contract returned by defineApiVersions().
 * @param {import('zod').ZodTypeAny} [config.body]
 * @param {import('zod').ZodTypeAny} [config.params]
 * @param {import('zod').ZodTypeAny} [config.query]
 * @param {import('zod').ZodObject} [config.headers] - Lowercase request headers, parsed into input.headers.
 * @param {Array<object>} [config.security] - OpenAPI requirements; rules still enforce access.
 * @param {object} [config.requestBody] - Wire documentation: description, contentType, example, required, multipart files, or rawBody schema.
 * @param {any} [config.response]
 * @param {Record<string | number, any>} [config.responses]
 * @param {Array<Function>} [config.beforeBodyRules=[]] - Rules that run before request body parsing.
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
 *   multipart?: boolean|object,
 *   rawBody?: boolean|object,
 *   body?: any,
 *   params?: any,
 *   query?: any,
 *   response?: any,
 *   responses?: Record<string | number, any>,
 *   beforeBodyRules: Array<Function>,
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
    multipart = false,
    rawBody = false,
    apiVersions,
    body,
    params,
    query,
    headers,
    security,
    requestBody,
    response,
    responses,
    beforeBodyRules = [],
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
  assertHttpDocumentation({ headers, requestBody, rawBody, multipart, security });
  assertApiVersions(apiVersions, normalizedMethod, path, {
    body,
    response,
    responses
  });

  let endpoint = {
    method: normalizedMethod,
    path,
    summary,
    description,
    tags: frozenPlain(tags),
    operationId,
    traceName,
    maxBodyBytes,
    multipart: frozenPlain(multipart),
    rawBody: frozenPlain(rawBody),
    ...(apiVersions === undefined ? {} : { apiVersions }),
    body,
    params,
    query,
    ...(headers === undefined ? {} : { headers }),
    ...(security === undefined ? {} : { security: frozenPlain(security) }),
    ...(requestBody === undefined ? {} : { requestBody: frozenPlain(requestBody) }),
    response: frozenPlain(response),
    responses: frozenPlain(responses),
    beforeBodyRules: Object.freeze([...beforeBodyRules]),
    rules: Object.freeze([...rules]),

    async handle(request, context = {}, {
      apiVersionNegotiation,
      timing
    } = {}) {
      let negotiation = apiVersions
        ? apiVersionNegotiation ?? resolveEndpointApiVersion(endpoint, request)
        : undefined;
      let versionContract = endpointVersionContract(endpoint, negotiation?.version);
      let versionContext = negotiation ? {
        ...context,
        apiVersion: negotiation.version
      } : context;
      let input = await timePhase(timing, 'validationMs', () => ({
        body: requestBodyForVersion(body, versionContract, request, versionContext),
        params: parseRequestObjectSchema(params, request.params),
        query: parseRequestObjectSchema(query, request.query),
        ...(headers === undefined ? {} : {
          headers: parseRequestHeaders(headers, request.headers)
        })
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
      let serializerContext = negotiation ? {
        ...handlerContext,
        apiVersion: negotiation.version
      } : handlerContext;

      return await timePhase(timing, 'responseValidationMs', () =>
        parseEndpointResponse(endpoint, result, versionContract, serializerContext)
      );
    }
  };

  return Object.freeze(endpoint);
}

/**
 * Mark an endpoint as deprecated without changing its request/response behavior.
 *
 * Deprecation is endpoint metadata for docs, inspect output, observability, and
 * optional response headers. It does not disable routing, validation, rules, or handlers.
 *
 * @param {object} endpoint - Endpoint returned by defineEndpoint().
 * @param {string|object} deprecation - Deprecation reason or metadata.
 * @returns {object} Endpoint copy with normalized deprecation metadata.
 */
export function deprecateEndpoint(endpoint, deprecation) {
  if (!endpoint || typeof endpoint !== 'object')
    throw new Error('Endpoint is required');

  return Object.freeze({
    ...endpoint,
    deprecation: frozenPlain(normalizeDeprecation(deprecation))
  });
}

function parseEndpointResponse(endpoint, result, versionContract, context) {
  let response = resolveHttpResponse(result, defaultStatusForMethod(endpoint.method));

  if (response.redirect)
    return response;

  let serializer = responseSerializerFor(versionContract, response.status);
  let canonicalBody = parseResponse(
    responseSchemaFrom(responseDefinitionFor(endpoint, response.status)),
    response.body
  );
  let body = serializer ? serializer(canonicalBody, context) : canonicalBody;

  return withResponseBody(response, body);
}
