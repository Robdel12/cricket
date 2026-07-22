import {
  badRequest,
  payloadTooLarge
} from '../errors.js';

let defaultMaxBodyBytes = 10 * 1024 * 1024;
let securityHeaderNames = [
  'authorization',
  'cookie'
];
function headerValues(headers, rawHeaders, name) {
  let lowerName = name.toLowerCase();
  let rawValues = [];

  for (let index = 0; index < (rawHeaders?.length ?? 0); index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === lowerName)
      rawValues.push(String(rawHeaders[index + 1]));
  }

  if (rawValues.length)
    return rawValues;

  let value = headers?.[lowerName];

  if (Array.isArray(value))
    return value.map(String);

  return value === undefined ? [] : [String(value)];
}

export function singleHeaderValue(req, name, {
  ambiguousMessage,
  rejectCommaSeparated = false,
  requiredMessage
} = {}) {
  let values = headerValues(req.headers, req.rawHeaders, name);

  if (!values.length) {
    if (requiredMessage)
      throw badRequest(requiredMessage);

    return undefined;
  }

  if (values.length > 1)
    throw badRequest(ambiguousMessage ?? `Ambiguous ${name} header`);

  if (rejectCommaSeparated && values[0].includes(','))
    throw badRequest(ambiguousMessage ?? `Ambiguous ${name} header`);

  return values[0];
}

function assertSingleSecurityHeaders(req) {
  for (let name of securityHeaderNames)
    singleHeaderValue(req, name, {
      ambiguousMessage: `Ambiguous ${name} header`
    });
}

function normalizeProtocol(value) {
  let protocol = value?.toLowerCase();

  if (protocol === 'http' || protocol === 'https')
    return protocol;

  return undefined;
}

function isValidHost(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s\x00-\x1F\x7F]/.test(value) &&
    /^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(?::[0-9]{1,5})?$/.test(value) &&
    hasValidPort(value);
}

function hasValidPort(value) {
  let port = /^\[.*\]:(\d{1,5})$/.exec(value)?.[1]
    ?? /^[A-Za-z0-9.-]+:(\d{1,5})$/.exec(value)?.[1];

  if (!port)
    return true;

  let number = Number(port);

  return number > 0 && number <= 65535;
}

function hostFrom(req, trustProxy) {
  let host = trustProxy
    ? singleHeaderValue(req, 'x-forwarded-host', {
      ambiguousMessage: 'Ambiguous x-forwarded-host header',
      rejectCommaSeparated: true
    })
    : undefined;

  host ??= singleHeaderValue(req, 'host', {
    ambiguousMessage: 'Ambiguous Host header',
    requiredMessage: 'Host header is required'
  });

  host = String(host).trim();

  if (!isValidHost(host))
    throw badRequest('Invalid Host header');

  return host;
}

function protocolFrom(req, trustProxy) {
  return normalizeProtocol(
    trustProxy ? singleHeaderValue(req, 'x-forwarded-proto', {
      ambiguousMessage: 'Ambiguous x-forwarded-proto header',
      rejectCommaSeparated: true
    }) : undefined
  ) ?? (req.socket?.encrypted ? 'https' : 'http');
}

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function setPlainValue(object, name, value) {
  Object.defineProperty(object, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function appendPlainValue(object, name, value) {
  if (!Object.hasOwn(object, name)) {
    setPlainValue(object, name, value);
    return;
  }

  setPlainValue(object, name, [
    ...(Array.isArray(object[name]) ? object[name] : [object[name]]),
    value
  ]);
}

function parseCookieHeader(header) {
  if (!header)
    return {};

  let cookies = {};

  for (let cookie of String(header).split(';')) {
    let trimmed = cookie.trim();

    if (!trimmed)
      continue;

    let separatorIndex = trimmed.indexOf('=');
    let name = safeDecodeUriComponent(
      separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex)
    );
    let value = safeDecodeUriComponent(
      separatorIndex === -1 ? '' : trimmed.slice(separatorIndex + 1)
    );

    if (Object.hasOwn(cookies, name))
      continue;

    setPlainValue(cookies, name, value);
  }

  return cookies;
}

function hasDotSegment(path) {
  return path
    .split('/')
    .some(segment => {
      let normalized = segment.replace(/%2e/gi, '.');

      return normalized === '.' || normalized === '..';
    });
}

function assertRouteSafePath(path) {
  if (!path.startsWith('/') || path.startsWith('//') || hasDotSegment(path))
    throw badRequest('Invalid request target');
}

function parsedOriginFormTarget(target) {
  if (target.includes('#'))
    throw badRequest('Invalid request target');

  let queryIndex = target.indexOf('?');
  let path = queryIndex === -1 ? target : target.slice(0, queryIndex);
  let query = queryIndex === -1 ? '' : target.slice(queryIndex + 1);

  assertRouteSafePath(path);

  return {
    path,
    searchParams: new URLSearchParams(query)
  };
}

function requestTargetFrom(req) {
  let target = req.url ?? '/';

  if (target === '*') {
    if (req.method?.toUpperCase() !== 'OPTIONS')
      throw badRequest('Invalid request target');

    return {
      path: '/',
      searchParams: new URLSearchParams(),
      raw: target
    };
  }

  if (target.startsWith('/')) {
    let parsed = parsedOriginFormTarget(target);

    return {
      ...parsed,
      raw: target
    };
  }

  throw badRequest('Invalid request target');
}

function paramsFromSearchParams(searchParams) {
  let params = {};

  for (let [name, value] of searchParams.entries())
    appendPlainValue(params, name, value);

  return params;
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

/**
 * Create a Cricket request object from a Node HTTP request.
 *
 * This normalizes the HTTP request into Cricket's plain-object shape with parsed
 * cookies, headers, host, and other metadata needed by endpoints and rules.
 *
 * @param {object} req - Node HTTP request object.
 * @param {object} req.headers - Request headers.
 * @param {string[]} [req.rawHeaders] - Raw header names and values.
 * @param {string} [req.method] - HTTP method.
 * @param {string} [req.url] - Request URL.
 * @param {object} req.socket - Socket object for protocol detection.
 * @param {boolean} [options.trustProxy=false] - Whether to trust X-Forwarded-* headers.
 * @returns {{
 *   body: undefined,
 *   cookies: object,
 *   file: undefined,
 *   files: Array,
 *   headers: object,
 *   host: string,
 *   method: string,
 *   origin: string,
 *   params: object,
 *   path: string,
 *   protocol: string,
 *   query: object,
 *   rawBody: undefined,
 *   rawHeaders: Array,
 *   secure: boolean,
 *   url: string
 * }}
 */
export function createBaseRequest(req, {
  trustProxy = false
} = {}) {
  assertBodyFraming(req);
  assertSingleSecurityHeaders(req);

  let requestTarget = requestTargetFrom(req);
  let host = hostFrom(req, trustProxy);
  let protocol = protocolFrom(req, trustProxy);

  return {
    body: undefined,
    cookies: parseCookieHeader(req.headers.cookie),
    file: undefined,
    files: [],
    headers: req.headers,
    host,
    method: req.method ?? 'GET',
    origin: `${protocol}://${host}`,
    params: {},
    path: requestTarget.raw === '*' ? '*' : requestTarget.path,
    protocol,
    query: paramsFromSearchParams(requestTarget.searchParams),
    rawBody: undefined,
    rawHeaders: req.rawHeaders ?? [],
    secure: protocol === 'https',
    url: requestTarget.raw
  };
}

/**
 * Return a redacted request snapshot for logs, events, and replay artifacts.
 *
 * Values that commonly carry secrets or user input are represented by names or
 * booleans only: headers, cookies, query values, body, and raw body.
 *
 * @param {object} request - Cricket request object.
 * @returns {object} Safe request summary.
 */
export function safeRequestSnapshot(request = {}) {
  return {
    id: request.id,
    method: request.method,
    path: request.path,
    protocol: request.protocol,
    host: request.host,
    origin: request.origin,
    secure: request.secure,
    headers: sortedKeys(request.headers),
    cookies: sortedKeys(request.cookies),
    query: sortedKeys(request.query),
    params: sortedKeys(request.params),
    hasBody: request.body !== undefined,
    hasRawBody: request.rawBody !== undefined
  };
}

function hostAllowedBy(allowedHost, host, request) {
  if (typeof allowedHost === 'function')
    return allowedHost(host, request);

  if (allowedHost instanceof RegExp) {
    allowedHost.lastIndex = 0;
    let matches = allowedHost.test(host);
    allowedHost.lastIndex = 0;
    return matches;
  }

  return String(allowedHost).toLowerCase() === host.toLowerCase();
}

/**
 * Assert that the request host is in the allowed hosts list.
 *
 * Host validation helps prevent host header injection attacks. Allowed hosts can be
 * strings, RegExp patterns, or functions that evaluate the host dynamically.
 *
 * @param {object} request - Cricket request object with a `host` property.
 * @param {string|RegExp|Function|string[]|undefined} allowedHosts - Host allowlist.
 * @throws {Error} When the host is not in the allowed list.
 */
export function assertAllowedHost(request, allowedHosts) {
  if (!allowedHosts)
    return;

  let hosts = Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts];

  if (!hosts.length)
    return;

  if (hosts.some(allowedHost => hostAllowedBy(allowedHost, request.host, request)))
    return;

  throw badRequest('Host not allowed');
}

function maxBodyBytesFor(endpoint) {
  return endpoint?.maxBodyBytes
    ?? endpoint?.rawBody?.maxBytes
    ?? defaultMaxBodyBytes;
}

function assertBodyFraming(req) {
  let contentLengths = headerValues(req.headers, req.rawHeaders, 'content-length')
    .map(value => value.trim());
  let transferEncodings = headerValues(req.headers, req.rawHeaders, 'transfer-encoding')
    .map(value => value.trim().toLowerCase());
  let transferEncoding = transferEncodings[0];
  let method = req.method?.toUpperCase();
  let bodylessMethod = ['GET', 'HEAD'].includes(method);

  if (transferEncodings.length > 1)
    throw badRequest('Invalid Transfer-Encoding header');

  if (transferEncoding && transferEncoding !== 'chunked')
    throw badRequest('Invalid Transfer-Encoding header');

  if (transferEncoding && contentLengths.length)
    throw badRequest('Conflicting request body framing headers');

  if (contentLengths.length > 1)
    throw badRequest('Invalid Content-Length header');

  if (contentLengths[0] && !/^\d+$/.test(contentLengths[0]))
    throw badRequest('Invalid Content-Length header');

  if (bodylessMethod && transferEncoding)
    throw badRequest(`${method} requests cannot include a body`);

  if (bodylessMethod && Number(contentLengths[0] ?? 0) > 0)
    throw badRequest(`${method} requests cannot include a body`);
}

function assertContentLength(request, maxBytes) {
  let rawHeader = request.headers['content-length'];
  let rawContentLength = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!rawContentLength)
    return;

  let value = String(rawContentLength).trim();

  if (!/^\d+$/.test(value))
    throw badRequest('Invalid Content-Length header');

  let contentLength = Number(value);

  if (!Number.isSafeInteger(contentLength))
    throw payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, {
      maxBytes
    });

  if (contentLength > maxBytes)
    throw payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, {
      maxBytes
    });
}

/**
 * Read the request body from a Node HTTP request stream.
 *
 * This buffers the request body up to the maximum allowed size and returns it as a
 * Buffer. It handles request abort/cleanup events and enforces size limits.
 *
 * @param {object} req - Node HTTP request with 'data', 'end', 'aborted', 'close', 'error' events.
 * @param {object} [options]
 * @param {number} [options.maxBytes=10MB] - Maximum body size in bytes.
 * @returns {Promise<Buffer>} The request body as a Buffer.
 * @throws {Error} When the body exceeds maxBytes, request is aborted, or connection closes.
 */
export function readRequestBody(req, {
  maxBytes = defaultMaxBodyBytes
} = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let totalBytes = 0;
    let settled = false;

    function finish(callback, value) {
      if (settled)
        return;

      settled = true;
      callback(value);
    }

    req.on('data', chunk => {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > maxBytes) {
        finish(reject, payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, {
          maxBytes
        }));
        req.resume();
        return;
      }

      chunks.push(buffer);
    });

    req.on('end', () => {
      finish(resolve, Buffer.concat(chunks));
    });

    req.on('aborted', () => {
      finish(reject, badRequest('Request aborted'));
    });
    req.on('close', () => {
      if (!req.complete)
        finish(reject, badRequest('Request closed before the body was complete'));
    });
    req.on('error', error => finish(reject, error));
  });
}

function contentTypeFor(request) {
  return String(singleHeaderValue(request, 'content-type', {
    ambiguousMessage: 'Ambiguous Content-Type header'
  }) ?? '').split(';')[0].trim().toLowerCase();
}

function isJsonContentType(contentType) {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function charsetFor(headers) {
  let contentType = singleHeaderValue({
    headers,
    rawHeaders: undefined
  }, 'content-type', {
    ambiguousMessage: 'Ambiguous Content-Type header'
  }) ?? '';
  let match = /(?:^|;)\s*charset\s*=\s*("[^"]*"|[^;]*)/i.exec(contentType);
  let charset = match?.[1]?.trim().replace(/^"|"$/g, '').toLowerCase() || 'utf-8';

  if (charset === 'utf8' || charset === 'utf-8')
    return 'utf8';

  throw badRequest('Unsupported request body charset');
}

function bufferToString(buffer, headers) {
  return buffer.toString(charsetFor(headers));
}

function parseJson(buffer, headers) {
  if (!buffer.length)
    return undefined;

  try {
    return JSON.parse(bufferToString(buffer, headers));
  } catch (error) {
    if (error.code === 'BAD_REQUEST')
      throw error;

    throw badRequest('Invalid JSON request body', {
      cause: error.message
    });
  }
}

function parseForm(buffer, headers) {
  let params = new URLSearchParams(bufferToString(buffer, headers));
  return paramsFromSearchParams(params);
}

/**
 * Parse and attach the request body to a Cricket request object.
 *
 * Handles JSON, form-urlencoded, and raw body parsing based on the endpoint's
 * `rawBody` configuration. GET and HEAD requests skip body parsing.
 *
 * @param {object} req - Node HTTP request stream.
 * @param {object} request - Cricket request object from createBaseRequest.
 * @param {object} [endpoint] - Endpoint config with optional `rawBody` and `maxBodyBytes`.
 * @param {boolean|object} [endpoint.rawBody] - When truthy, returns raw body instead of parsing.
 * @param {number} [endpoint.maxBodyBytes] - Override for maximum body size.
 * @returns {Promise<object>} Request object with body/rawBody populated.
 */
export async function completeRequestBody(req, request, endpoint) {
  if (!endpoint?.rawBody && ['GET', 'HEAD'].includes(request.method.toUpperCase()))
    return request;

  let maxBytes = maxBodyBytesFor(endpoint);
  assertContentLength(request, maxBytes);

  let raw = await readRequestBody(req, {
    maxBytes
  });
  let rawBody = endpoint?.rawBody
    ? (endpoint.rawBody?.encoding === false ? raw : raw.toString(endpoint.rawBody?.encoding ?? 'utf8'))
    : undefined;

  if (endpoint?.rawBody) {
    return {
      ...request,
      rawBody
    };
  }

  let contentType = contentTypeFor(request);

  if (isJsonContentType(contentType)) {
    return {
      ...request,
      body: parseJson(raw, request.headers)
    };
  }

  if (contentType === 'application/x-www-form-urlencoded') {
    return {
      ...request,
      body: parseForm(raw, request.headers)
    };
  }

  return {
    ...request,
    body: raw.length ? bufferToString(raw, request.headers) : undefined
  };
}
