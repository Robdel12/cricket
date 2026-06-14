import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  validateHeaderName,
  validateHeaderValue
} from 'node:http';

let hopByHopResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function appendHeader(headers, name, value) {
  let lowerName = name.toLowerCase();
  let existing = headers[lowerName];

  if (!existing) {
    headers[lowerName] = value;
    return;
  }

  headers[lowerName] = [
    ...(Array.isArray(existing) ? existing : [existing]),
    value
  ];
}

function serializeCookieOption(name, value) {
  if (value === true)
    return name;

  if (value === false || value === undefined || value === null)
    return undefined;

  return `${name}=${value}`;
}

function normalizedCookieSameSite(value) {
  if (value === false || value === undefined || value === null)
    return undefined;

  if (value === true)
    return 'Strict';

  let normalized = String(value).toLowerCase();
  let values = {
    lax: 'Lax',
    strict: 'Strict',
    none: 'None'
  };

  return values[normalized];
}

function normalizedCookiePriority(value) {
  if (value === false || value === undefined || value === null)
    return undefined;

  let normalized = String(value).toLowerCase();
  let values = {
    low: 'Low',
    medium: 'Medium',
    high: 'High'
  };

  return values[normalized];
}

function assertValidCookieMaxAge(value) {
  if (
    value === false ||
    value === undefined ||
    value === null
  )
    return;

  if (
    typeof value === 'boolean' ||
    String(value).trim() === '' ||
    !Number.isInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error('Invalid response cookie option: maxAge');
}

function serializeCookie(cookie) {
  assertValidCookie(cookie);

  let options = cookie.options ?? {};
  let sameSite = normalizedCookieSameSite(options.sameSite);
  let priority = normalizedCookiePriority(options.priority);
  let parts = [
    `${encodeURIComponent(cookie.name)}=${encodeURIComponent(cookie.value ?? '')}`,
    serializeCookieOption('Max-Age', options.maxAge),
    serializeCookieOption('Domain', options.domain),
    serializeCookieOption('Path', options.path ?? '/'),
    serializeCookieOption('Expires', options.expires?.toUTCString?.()),
    serializeCookieOption('HttpOnly', options.httpOnly),
    serializeCookieOption('Secure', options.secure),
    serializeCookieOption('SameSite', sameSite),
    serializeCookieOption('Partitioned', options.partitioned),
    serializeCookieOption('Priority', priority)
  ].filter(Boolean);

  return parts.join('; ');
}

function assertValidCookie(cookie) {
  if (!cookie?.name || /[\x00-\x1F\x7F\s()<>@,;:\\"/[\]?={}]/.test(cookie.name))
    throw new Error('Invalid response cookie name');

  let options = cookie.options ?? {};
  let sameSite = normalizedCookieSameSite(options.sameSite);
  let priority = normalizedCookiePriority(options.priority);
  let secure = options.secure === true;
  let path = options.path ?? '/';

  if (options.sameSite !== false && options.sameSite !== undefined && options.sameSite !== null && !sameSite)
    throw new Error('Invalid response cookie option: sameSite');

  if (options.priority !== false && options.priority !== undefined && options.priority !== null && !priority)
    throw new Error('Invalid response cookie option: priority');

  if (sameSite === 'None' && !secure)
    throw new Error('Response cookie SameSite=None requires Secure');

  if (options.partitioned && !secure)
    throw new Error('Response cookie Partitioned requires Secure');

  if (cookie.name.startsWith('__Secure-') && !secure)
    throw new Error('Response cookie __Secure- prefix requires Secure');

  if (cookie.name.startsWith('__Host-') && (!secure || options.domain || path !== '/'))
    throw new Error('Response cookie __Host- prefix requires Secure, Path=/, and no Domain');

  assertValidCookieMaxAge(options.maxAge);

  if (
    options.expires !== false &&
    options.expires !== undefined &&
    options.expires !== null &&
    (!(options.expires instanceof Date) || Number.isNaN(options.expires.getTime()))
  )
    throw new Error('Invalid response cookie option: expires');

  for (let [name, value] of Object.entries(options)) {
    if (value === false || value === undefined || value === null)
      continue;

    if (/[\r\n;]/.test(String(value)))
      throw new Error(`Invalid response cookie option: ${name}`);
  }
}

function cookieAttributesFromHeader(value) {
  let parts = String(value).split(';').map(part => part.trim());
  let [pair, ...attributes] = parts;
  let separatorIndex = pair.indexOf('=');
  let name = pair.slice(0, separatorIndex);
  let cookieValue = pair.slice(separatorIndex + 1);
  let options = {};

  if (separatorIndex <= 0 || /[\x00-\x1F\x7F\s()<>@,;:\\"/[\]?={}]/.test(name))
    throw new Error('Invalid response cookie name');

  if (/[\x00-\x1F\x7F;]/.test(cookieValue))
    throw new Error('Invalid response cookie value');

  for (let attribute of attributes) {
    if (!attribute)
      continue;

    let attributeSeparatorIndex = attribute.indexOf('=');
    let rawName = attributeSeparatorIndex === -1
      ? attribute
      : attribute.slice(0, attributeSeparatorIndex);
    let rawValue = attributeSeparatorIndex === -1
      ? true
      : attribute.slice(attributeSeparatorIndex + 1);
    let attributeName = rawName.trim().toLowerCase();

    if (!attributeName || /[\x00-\x1F\x7F\s()<>@,;:\\"/[\]?={}]/.test(attributeName))
      throw new Error('Invalid response cookie option');

    let optionKey = cookieOptionKey(attributeName);

    if (Object.hasOwn(options, optionKey))
      throw new Error(`Ambiguous response cookie option: ${attributeName}`);

    if (rawValue !== true && /[\r\n;]/.test(String(rawValue)))
      throw new Error(`Invalid response cookie option: ${attributeName}`);

    options[optionKey] = rawValue;
  }

  return {
    name,
    options
  };
}

function cookieOptionKey(name) {
  let aliases = {
    domain: 'domain',
    expires: 'expires',
    httponly: 'httpOnly',
    'max-age': 'maxAge',
    partitioned: 'partitioned',
    path: 'path',
    priority: 'priority',
    samesite: 'sameSite',
    secure: 'secure'
  };

  return aliases[name] ?? name;
}

function assertValidSetCookieHeader(value) {
  let cookie = cookieAttributesFromHeader(value);
  let options = cookie.options;
  let sameSite = normalizedCookieSameSite(options.sameSite);
  let priority = normalizedCookiePriority(options.priority);
  let secure = options.secure === true;
  let path = options.path ?? '/';

  if (options.sameSite !== undefined && !sameSite)
    throw new Error('Invalid response cookie option: sameSite');

  if (options.priority !== undefined && !priority)
    throw new Error('Invalid response cookie option: priority');

  if (sameSite === 'None' && !secure)
    throw new Error('Response cookie SameSite=None requires Secure');

  if (options.partitioned && !secure)
    throw new Error('Response cookie Partitioned requires Secure');

  if (cookie.name.startsWith('__Secure-') && !secure)
    throw new Error('Response cookie __Secure- prefix requires Secure');

  if (cookie.name.startsWith('__Host-') && (!secure || options.domain || path !== '/'))
    throw new Error('Response cookie __Host- prefix requires Secure, Path=/, and no Domain');

  assertValidCookieMaxAge(options.maxAge);

  if (options.expires !== undefined && Number.isNaN(Date.parse(options.expires)))
    throw new Error('Invalid response cookie option: expires');
}

function applyResponseCleanup(req, res, response) {
  if (typeof response.onClose !== 'function')
    return () => {};

  let closed = false;
  let close = () => {
    if (closed)
      return;

    closed = true;

    try {
      let cleanup = response.onClose();
      cleanup?.catch?.(() => {});
    } catch {
      // Cleanup callbacks run after the response path is committed.
    }
  };

  req.on('close', close);
  req.on('error', close);
  res.on('close', close);
  res.on('error', close);
  response.body?.on?.('close', close);
  response.body?.on?.('error', close);

  return close;
}

function isReadable(value) {
  return value instanceof Readable || typeof value?.pipe === 'function';
}

function isWebReadable(value) {
  return typeof value?.getReader === 'function';
}

function isWebResponse(value) {
  return value &&
    typeof value.status === 'number' &&
    typeof value.headers?.forEach === 'function' &&
    typeof value.arrayBuffer === 'function';
}

function isBinary(value) {
  return Buffer.isBuffer(value)
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value);
}

function binaryBuffer(value) {
  if (Buffer.isBuffer(value))
    return value;

  if (value instanceof ArrayBuffer)
    return Buffer.from(value);

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function preparedBody(body, headers) {
  if (body === undefined || body === null) {
    return {
      kind: 'empty'
    };
  }

  if (isReadable(body) || isWebReadable(body)) {
    return {
      kind: 'stream',
      body: isWebReadable(body) ? Readable.fromWeb(body) : body
    };
  }

  if (isBinary(body) || typeof body === 'string') {
    return {
      kind: 'buffer',
      body: isBinary(body) ? binaryBuffer(body) : body
    };
  }

  if (!headers['content-type'])
    headers['content-type'] = 'application/json; charset=utf-8';

  return {
    kind: 'buffer',
    body: JSON.stringify(body)
  };
}

function contentLengthFor(body) {
  if (body.kind !== 'buffer')
    return undefined;

  return typeof body.body === 'string'
    ? Buffer.byteLength(body.body)
    : body.body.length;
}

function normalizedContentLength(value) {
  if (Array.isArray(value))
    throw new Error('Invalid response Content-Length header');

  let normalized = String(value).trim();

  if (!/^\d+$/.test(normalized))
    throw new Error('Invalid response Content-Length header');

  let contentLength = Number(normalized);

  if (!Number.isSafeInteger(contentLength))
    throw new Error('Invalid response Content-Length header');

  return contentLength;
}

function applyContentLength(headers, contentLength) {
  if (contentLength === undefined)
    return;

  if (headers['content-length'] === undefined) {
    headers['content-length'] = String(contentLength);
    return;
  }

  if (normalizedContentLength(headers['content-length']) !== contentLength)
    throw new Error('Response Content-Length does not match body size');
}

function assertContentLengthFraming(headers, body) {
  if (headers['content-length'] === undefined)
    return;

  if (body.kind === 'stream') {
    body.body.destroy?.();
    throw new Error('Streaming responses cannot set Content-Length');
  }

  if (body.kind === 'empty' && normalizedContentLength(headers['content-length']) !== 0)
    throw new Error('Response Content-Length does not match body size');
}

function discardBody(body) {
  if (isWebReadable(body)) {
    body.cancel?.().catch?.(() => {});
    return;
  }

  if (isReadable(body))
    body.destroy();
}

function discardPreparedBody(body) {
  if (body.kind === 'stream')
    discardBody(body.body);
}

function writePreparedBody(res, body) {
  if (body.kind === 'empty') {
    res.end();
    return;
  }

  if (body.kind === 'stream') {
    void pipeline(body.body, res).catch(error => {
      if (!res.destroyed)
        res.destroy(error);
    });
    return;
  }

  res.end(body.body);
}

function writeNoBodyResponse(res, body) {
  discardPreparedBody(body);
  res.removeHeader('content-length');
  res.removeHeader('content-type');
  res.removeHeader('transfer-encoding');
  res.end();
}

function statusFor(response) {
  if (!response?.redirect)
    return response?.status ?? 200;

  let status = response.status ?? 303;

  if (status < 300 || status > 399)
    return 303;

  return status;
}

function assertValidStatus(status) {
  if (!Number.isInteger(status) || status < 200 || status > 599)
    throw new Error(`Invalid response status: ${status}`);
}

function isMultipartByteRange(headers) {
  return String(headers['content-type'] ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim() === 'multipart/byteranges';
}

function assertContentRangeStatus(headers, status) {
  if (headers['content-range'] !== undefined && ![206, 416].includes(status))
    throw new Error('Content-Range is only valid for 206 or 416 responses');

  if (
    status === 206 &&
    headers['content-range'] === undefined &&
    !isMultipartByteRange(headers)
  )
    throw new Error('Partial content responses require Content-Range');
}

function assertValidHeaders(headers, status) {
  assertContentRangeStatus(headers, status);

  for (let [name, value] of Object.entries(headers)) {
    validateHeaderName(name);

    if (hopByHopResponseHeaders.has(name.toLowerCase()))
      throw new Error(`Unsupported response header: ${name}`);

    for (let headerValue of Array.isArray(value) ? value : [value]) {
      validateHeaderValue(name, headerValue);

      if (name.toLowerCase() === 'set-cookie')
        assertValidSetCookieHeader(headerValue);
    }
  }
}

function prepareResponse(response) {
  if (isWebResponse(response))
    return prepareWebResponse(response);

  let headers = {};

  if (response?.headers) {
    for (let [name, value] of Object.entries(response.headers)) {
      if (value !== undefined)
        headers[name.toLowerCase()] = value;
    }
  }

  if (response?.cookies) {
    for (let cookie of response.cookies)
      appendHeader(headers, 'set-cookie', serializeCookie(cookie));
  }

  if (response?.redirect)
    headers.location = response.redirect;

  let body = preparedBody(response?.body, headers);
  let contentLength = contentLengthFor(body);

  assertContentLengthFraming(headers, body);
  applyContentLength(headers, contentLength);

  return {
    body,
    headers,
    status: statusFor(response)
  };
}

function headersFromWebResponse(response) {
  let headers = {};

  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });

  let setCookies = response.headers.getSetCookie?.();

  if (setCookies?.length)
    headers['set-cookie'] = setCookies;

  return headers;
}

function prepareWebResponse(response) {
  let headers = headersFromWebResponse(response);

  let body = preparedBody(response.body, headers);
  let contentLength = contentLengthFor(body);

  assertContentLengthFraming(headers, body);
  applyContentLength(headers, contentLength);

  return {
    body,
    headers,
    status: response.status
  };
}

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag)
    return false;

  let normalizedEtag = String(etag).replace(/^W\//, '');

  return String(ifNoneMatch)
    .split(',')
    .map(value => value.trim())
    .some(value => value === '*' || value.replace(/^W\//, '') === normalizedEtag);
}

function modifiedSinceMatches(ifModifiedSince, lastModified) {
  if (!ifModifiedSince || !lastModified)
    return false;

  let requested = Date.parse(ifModifiedSince);
  let modified = Date.parse(lastModified);

  return Number.isFinite(requested) &&
    Number.isFinite(modified) &&
    modified <= requested;
}

function applyConditionalRequest(req, prepared) {
  if (!['GET', 'HEAD'].includes(req.method) || prepared.status !== 200)
    return prepared;

  if (etagMatches(req.headers['if-none-match'], prepared.headers.etag)) {
    return {
      ...prepared,
      status: 304
    };
  }

  if (req.headers['if-none-match'])
    return prepared;

  if (modifiedSinceMatches(req.headers['if-modified-since'], prepared.headers['last-modified'])) {
    return {
      ...prepared,
      status: 304
    };
  }

  return prepared;
}

export function writeHttpResponse(req, res, response) {
  let cleanup = applyResponseCleanup(req, res, response ?? {});
  let prepared;

  try {
    prepared = applyConditionalRequest(req, prepareResponse(response));
    assertValidStatus(prepared.status);
    assertValidHeaders(prepared.headers, prepared.status);
  } catch (error) {
    cleanup();
    discardBody(response?.body);
    throw error;
  }

  res.statusCode = prepared.status;

  for (let [name, value] of Object.entries(prepared.headers))
    res.setHeader(name, value);

  if (response?.redirect) {
    writeNoBodyResponse(res, prepared.body);
    return;
  }

  if (prepared.status === 204 || prepared.status === 205 || prepared.status === 304) {
    writeNoBodyResponse(res, prepared.body);
    return;
  }

  if (req.method === 'HEAD') {
    discardPreparedBody(prepared.body);
    res.end();
    return;
  }

  writePreparedBody(res, prepared.body);
}
