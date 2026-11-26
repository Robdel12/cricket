import { frozenPlain } from './immutable.js';

let responseKind = Symbol('cricket.httpResponse');
let responseErrors = new WeakMap();

function assertResponse(response, helper) {
  if (!isHttpResponse(response))
    throw new Error(`${helper} needs a Cricket HTTP response`);
}

function responseValue({
  status,
  body,
  headers,
  cookies,
  location,
  cleanup,
  error
}) {
  let response = {
    status,
    ...(body === undefined ? {} : { body }),
    ...(headers ? { headers: frozenPlain(headers) } : {}),
    ...(cookies ? { cookies: frozenPlain(cookies) } : {}),
    ...(location ? { redirect: location } : {}),
    ...(cleanup ? { onClose: cleanup } : {})
  };

  Object.defineProperty(response, responseKind, {
    value: true
  });
  if (error !== undefined)
    responseErrors.set(response, error);
  return Object.freeze(response);
}

export function getResponseError(response) {
  return responseErrors.get(response);
}

/**
 * Return whether a value is an explicit Cricket HTTP response.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isHttpResponse(value) {
  return value?.[responseKind] === true;
}

/**
 * Turn a bare handler value into a default response while preserving explicit
 * Cricket responses created by the helpers in this module.
 *
 * @param {any} value
 * @param {number} defaultStatus
 * @returns {object}
 */
export function resolveHttpResponse(value, defaultStatus = 200) {
  return isHttpResponse(value) ? value : respond(defaultStatus, value);
}

/**
 * Replace the body while preserving an explicit response's transport metadata.
 * This is used after endpoint response validation.
 *
 * @param {object} response
 * @param {any} body
 * @returns {object}
 */
export function withResponseBody(response, body) {
  assertResponse(response, 'withResponseBody');

  return responseValue({
    ...response,
    error: getResponseError(response),
    body,
    location: response.redirect,
    cleanup: response.onClose
  });
}

/**
 * @guide responses Send responses
 *
 * Most handlers just return the body. Cricket sends it as JSON with a 200 (or 201 for `created`). When you need control over the status, headers, or cookies, wrap the body with a response helper.
 *
 * ## Pick a status
 *
 * ```js
 * import { created, ok, redirect, respond } from '@robdel12/cricket';
 *
 * return { project };                    // 200
 * return ok({ project });                // 200, spelled out
 * return created({ project });           // 201
 * return respond(202, { queued: true }); // any status
 * return redirect('/projects', 303);     // a redirect
 * ```
 *
 * Only these helpers can change the status. A plain object with a `status` or `redirect` field is just a body, so your data can't accidentally turn into transport instructions.
 *
 * ## Add headers and cookies
 *
 * ```js
 * import { ok, respond, withCookies, withHeaders } from '@robdel12/cricket';
 *
 * return withHeaders(respond(202, { queued: true }), { 'Retry-After': '5' });
 *
 * return withCookies(ok({ signedIn: true }), [{
 *   name: 'session',
 *   value: session.id,
 *   options: { httpOnly: true, secure: true }
 * }]);
 * ```
 *
 * ## Describe more than one status
 *
 * Use `responses` when a route can answer with different shapes. `response` is shorthand for the default success status.
 *
 * ```js
 * let readReport = defineEndpoint({
 *   method: 'get',
 *   path: '/reports/:id',
 *   responses: {
 *     200: z.object({ report: Report.public }),
 *     202: z.object({ status: z.literal('rendering') })
 *   },
 *   handler: ({ report }) => report.ready
 *     ? { report: serializeReport(report) }
 *     : respond(202, { status: 'rendering' })
 * });
 * ```
 *
 * Every response gets checked against its status. If the body doesn't match, the client gets a 500 and your logs get the details.
 *
 * ## Report an error you handled
 *
 * Sometimes you catch an error and send a friendly response instead. Attach the original with `withError` so your error reporting still sees it.
 *
 * <!-- example examples/error-reporting.js -->
 *
 * The body stays friendly, and `onError` gets the real exception. See [Follow a request](guide.md#follow-a-request) for reporting.
 *
 * ## Stream a file
 *
 * Return a Node stream and clean it up with `withResponseCleanup`. Set `Content-Length` when you know the size, and Cricket checks the stream actually sends that many bytes.
 *
 * <!-- example examples/known-length-stream.js -->
 *
 * Cricket handles backpressure, and it runs your cleanup even if the client disconnects halfway.
 */
/**
 * Create an explicit Cricket HTTP response with any valid final status.
 *
 * @param {number} status
 * @param {any} [body]
 * @returns {object}
 */
export function respond(status, body) {
  if (!Number.isInteger(status) || status < 200 || status > 599)
    throw new Error(`Invalid response status: ${status}`);

  return responseValue({
    status,
    body
  });
}

/**
 * Create a 200 response.
 *
 * @param {any} body
 * @returns {object}
 */
export function ok(body) {
  return respond(200, body);
}

/**
 * Create a 201 response.
 *
 * @param {any} body
 * @returns {object}
 */
export function created(body) {
  return respond(201, body);
}

/**
 * Create an explicit redirect response.
 *
 * @param {string} location
 * @param {number} [status=303]
 * @returns {object}
 */
export function redirect(location, status = 303) {
  if (typeof location !== 'string' || !location)
    throw new Error('redirect needs a location');
  if (!Number.isInteger(status) || status < 300 || status > 399)
    throw new Error(`Invalid redirect status: ${status}`);

  return responseValue({
    status,
    location
  });
}

/**
 * Compose response headers over an explicit Cricket response.
 *
 * @param {object} response
 * @param {Record<string, any>} headers
 * @returns {object}
 */
export function withHeaders(response, headers) {
  assertResponse(response, 'withHeaders');

  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw new Error('withHeaders needs a header object');

  return responseValue({
    ...response,
    error: getResponseError(response),
    headers: {
      ...response.headers,
      ...headers
    },
    location: response.redirect,
    cleanup: response.onClose
  });
}

/**
 * Replace every response header with an exact immutable header object.
 *
 * Framework response policies use this after case-insensitive normalization so
 * differently-cased caller headers cannot survive as duplicate wire fields.
 *
 * @param {object} response
 * @param {Record<string, any>} headers
 * @returns {object}
 */
export function withResponseHeaders(response, headers) {
  assertResponse(response, 'withResponseHeaders');

  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw new Error('withResponseHeaders needs a header object');

  return responseValue({
    ...response,
    error: getResponseError(response),
    headers,
    location: response.redirect,
    cleanup: response.onClose
  });
}

/**
 * Append response cookies to an explicit Cricket response.
 *
 * @param {object} response
 * @param {Array<object>} cookies
 * @returns {object}
 */
export function withCookies(response, cookies) {
  assertResponse(response, 'withCookies');

  if (!Array.isArray(cookies))
    throw new Error('withCookies needs a cookie array');

  return responseValue({
    ...response,
    error: getResponseError(response),
    cookies: [
      ...(response.cookies ?? []),
      ...cookies
    ],
    location: response.redirect,
    cleanup: response.onClose
  });
}

/**
 * Attach one cleanup callback to an explicit Cricket response.
 *
 * @param {object} response
 * @param {Function} cleanup
 * @returns {object}
 */
export function withResponseCleanup(response, cleanup) {
  assertResponse(response, 'withResponseCleanup');

  if (typeof cleanup !== 'function')
    throw new Error('withResponseCleanup needs a cleanup function');

  return responseValue({
    ...response,
    error: getResponseError(response),
    location: response.redirect,
    cleanup
  });
}

/** Keep a handled error for onError without adding it to the response body. */
export function withError(response, error) {
  assertResponse(response, 'withError');
  if (response.status < 400)
    throw new Error('withError needs an error response (status 400 or above)');
  if (error === undefined || error === null)
    throw new Error('withError needs an error');

  return responseValue({
    ...response,
    location: response.redirect,
    cleanup: response.onClose,
    error
  });
}
