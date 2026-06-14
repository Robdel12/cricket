import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType
} from '../errors.js';

let defaultMaxBodyBytes = 10 * 1024 * 1024;
let allowedConnectionTokens = new Set(['close', 'keep-alive']);
let securityHeaderNames = [
  'authorization',
  'cookie',
  'origin',
  'referer',
  'access-control-request-method',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user'
];
let commaJoinedSecurityHeaders = new Set([
  'origin',
  'access-control-request-method',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user'
]);
function headerValues(headers, rawHeaders, name) {
  let lowerName = name.toLowerCase();
  let rawValues = [];

  for (let index = 0; index < (rawHeaders?.length ?? 0); index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === lowerName)
      rawValues.push(String(rawHeaders[index + 1]));
  }

  if (rawValues.length)
    return rawValues;

  let value = headers[lowerName];

  if (Array.isArray(value))
    return value.map(String);

  return value === undefined ? [] : [String(value)];
}

function singleHeaderValue(req, name, {
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

function forwardedHeaderValue(req, name) {
  let value = singleHeaderValue(req, name, {
    ambiguousMessage: `Ambiguous ${name} header`
  });

  if (!value)
    return undefined;

  let values = String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  if (values.length > 1)
    throw badRequest(`Ambiguous ${name} header`);

  return values[0];
}

function unquotedForwardedValue(value) {
  let trimmed = value.trim();

  if (!trimmed.startsWith('"'))
    return trimmed;

  if (!trimmed.endsWith('"') || trimmed.length < 2)
    throw badRequest('Invalid Forwarded header');

  return trimmed
    .slice(1, -1)
    .replace(/\\(["\\])/g, '$1');
}

function forwardedParameters(req) {
  let value = singleHeaderValue(req, 'forwarded', {
    ambiguousMessage: 'Ambiguous Forwarded header',
    rejectCommaSeparated: true
  });

  if (!value)
    return {};

  let parameters = {};

  for (let part of value.split(';')) {
    let [rawName, ...rawValueParts] = part.split('=');
    let name = rawName.trim().toLowerCase();

    if (!name || !rawValueParts.length)
      throw badRequest('Invalid Forwarded header');

    if (!['host', 'proto'].includes(name))
      continue;

    if (Object.hasOwn(parameters, name))
      throw badRequest('Ambiguous Forwarded header');

    setPlainValue(parameters, name, unquotedForwardedValue(rawValueParts.join('=')));
  }

  return parameters;
}

function trustedProxyValue(req, forwarded, forwardedName, legacyName) {
  let modern = forwarded[forwardedName];
  let legacy = forwardedHeaderValue(req, legacyName);

  if (modern && legacy && modern !== legacy)
    throw badRequest(`Ambiguous ${legacyName} header`);

  return modern ?? legacy;
}

function assertSingleSecurityHeaders(req) {
  for (let name of securityHeaderNames)
    singleHeaderValue(req, name, {
      ambiguousMessage: `Ambiguous ${name} header`,
      rejectCommaSeparated: commaJoinedSecurityHeaders.has(name)
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

function hostFrom(req, trustProxy, requestTarget, forwarded) {
  if (requestTarget.host)
    return requestTarget.host;

  let host = trustProxy
    ? trustedProxyValue(req, forwarded, 'host', 'x-forwarded-host')
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

function protocolFrom(req, trustProxy, requestTarget, forwarded) {
  if (requestTarget.protocol)
    return requestTarget.protocol;

  return normalizeProtocol(
    trustProxy ? trustedProxyValue(req, forwarded, 'proto', 'x-forwarded-proto') : undefined
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

function parsedAbsoluteFormTarget(target) {
  if (target.includes('#'))
    throw badRequest('Invalid request target');

  let match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?(.*))?$/.exec(target);

  if (!match)
    throw badRequest('Invalid request target');

  let [, rawProtocol, rawHost, rawPath, rawQuery = ''] = match;

  if (rawHost.includes('@'))
    throw badRequest('Invalid request target');

  let url;

  try {
    url = new URL(target);
  } catch {
    throw badRequest('Invalid request target');
  }

  let protocol = normalizeProtocol(rawProtocol);
  let host = url.host;
  let path = rawPath || '/';

  if (!protocol || !host || url.username || url.password || !isValidHost(host))
    throw badRequest('Invalid request target');

  assertRouteSafePath(path);

  return {
    host,
    path,
    protocol,
    searchParams: new URLSearchParams(rawQuery)
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

  return {
    ...parsedAbsoluteFormTarget(target),
    raw: target
  };
}

function paramsFromSearchParams(searchParams) {
  let params = {};

  for (let [name, value] of searchParams.entries())
    appendPlainValue(params, name, value);

  return params;
}

export function createBaseRequest(req, {
  trustProxy = false
} = {}) {
  assertBodyFraming(req);
  assertSingleSecurityHeaders(req);

  let requestTarget = requestTargetFrom(req);
  let forwarded = trustProxy ? forwardedParameters(req) : {};
  let host = hostFrom(req, trustProxy, requestTarget, forwarded);
  let protocol = protocolFrom(req, trustProxy, requestTarget, forwarded);

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

function connectionTokens(req) {
  return headerValues(req.headers, req.rawHeaders, 'connection')
    .flatMap(value => String(value).split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function assertConnectionHeader(req) {
  let tokens = connectionTokens(req);

  if (!tokens.length)
    return;

  if (tokens.some(token => !allowedConnectionTokens.has(token)))
    throw badRequest('Unsupported Connection header');

  if (tokens.includes('close') && tokens.includes('keep-alive'))
    throw badRequest('Unsupported Connection header');
}

function assertBodyFraming(req) {
  let contentLengths = headerValues(req.headers, req.rawHeaders, 'content-length')
    .map(value => value.trim());
  let transferEncodings = headerValues(req.headers, req.rawHeaders, 'transfer-encoding')
    .map(value => value.trim().toLowerCase());
  let trailers = headerValues(req.headers, req.rawHeaders, 'trailer');
  let transferEncoding = transferEncodings[0];
  let method = req.method?.toUpperCase();
  let bodylessMethod = ['GET', 'HEAD'].includes(method);

  assertConnectionHeader(req);

  if (trailers.length)
    throw badRequest('Unsupported Trailer header');

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

function assertSupportedContentEncoding(request) {
  let values = headerValues(
    request.headers,
    request.rawHeaders,
    'content-encoding'
  );

  if (!values.length)
    return;

  let codings = values
    .join(',')
    .split(',')
    .map(coding => coding.trim().toLowerCase())
    .filter(Boolean);

  if (!codings.length || codings.every(coding => coding === 'identity'))
    return;

  throw unsupportedMediaType('Unsupported request content encoding');
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

export async function completeRequestBody(req, request, endpoint) {
  if (!endpoint?.rawBody && ['GET', 'HEAD'].includes(request.method.toUpperCase()))
    return request;

  let maxBytes = maxBodyBytesFor(endpoint);
  assertContentLength(request, maxBytes);
  assertSupportedContentEncoding(request);

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
