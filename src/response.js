import { frozenPlain } from './immutable.js';

let responseKind = Symbol('cricket.httpResponse');

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
  cleanup
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
  return Object.freeze(response);
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
    body,
    location: response.redirect,
    cleanup: response.onClose
  });
}

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
    headers: {
      ...response.headers,
      ...headers
    },
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
    location: response.redirect,
    cleanup
  });
}
