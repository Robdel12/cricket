import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { isPlainObject } from '../immutable.js';
import {
  defaultMaxBodyBytes,
  recordRequestBodyBytes,
  requestBodyBytes
} from './body-bytes.js';
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

function isReadable(value) {
  return value instanceof Readable || typeof value?.pipe === 'function';
}

function isBinary(value) {
  return Buffer.isBuffer(value);
}

function preparedBody(body, headers) {
  if (body === undefined || body === null) {
    return {
      kind: 'empty'
    };
  }

  if (isReadable(body)) {
    return {
      kind: 'stream',
      body
    };
  }

  if (isBinary(body) || typeof body === 'string') {
    return {
      kind: 'buffer',
      body
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

  let declaredLength = normalizedContentLength(headers['content-length']);
  if (body.kind === 'empty' && declaredLength !== 0)
    throw new Error('Response Content-Length does not match body size');

  return body.kind === 'stream' ? declaredLength : undefined;
}

function checkStreamLength(expectedLength) {
  let bytes = 0;
  let lastChunk;
  let mismatch = () => new Error('Response Content-Length does not match stream size');

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (chunk.length === 0) {
        callback();
        return;
      }

      bytes += chunk.length;
      if (bytes > expectedLength) {
        callback(mismatch());
        return;
      }

      // Hold the chunk that reaches the declared length until the source ends.
      // An overrun must not look like a complete successful response to a client.
      if (bytes === expectedLength) {
        lastChunk = chunk;
        callback();
        return;
      }

      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== expectedLength) {
        callback(mismatch());
        return;
      }

      if (lastChunk) this.push(lastChunk);
      lastChunk = undefined;
      callback();
    },
    destroy(error, callback) {
      lastChunk = undefined;
      callback(error);
    }
  });
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

function assertValidHeaders(headers) {
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

export function normalizeResponseHeaders(headers = {}) {
  if (!isPlainObject(headers))
    throw new Error('Response headers must be a plain object');

  let normalized = {};
  for (let [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      normalized[name.toLowerCase()] = Array.isArray(value) ? [...value] : value;
  }
  assertValidHeaders(normalized);
  return Object.freeze(Object.fromEntries(Object.entries(normalized).map(([name, value]) => [
    name,
    Array.isArray(value) ? Object.freeze(value) : value
  ])));
}

function prepareResponse(response) {
  let headers = { ...normalizeResponseHeaders(response?.headers ?? {}) };

  if (response?.cookies) {
    for (let cookie of response.cookies)
      appendHeader(headers, 'set-cookie', serializeCookie(cookie));
  }

  if (response?.redirect)
    headers.location = response.redirect;

  let body = preparedBody(response?.body, headers);
  let contentLength = contentLengthFor(body);

  let streamLength = assertContentLengthFraming(headers, body);
  applyContentLength(headers, contentLength);

  return {
    body,
    headers,
    streamLength,
    status: statusFor(response)
  };
}

function responseCookieNames(response = {}) {
  return (response.cookies ?? [])
    .map(cookie => cookie.name)
    .filter(Boolean)
    .sort();
}

function responseBodyKind(response = {}, {
  method
} = {}) {
  let status = statusFor(response);

  if (
    method?.toUpperCase?.() === 'HEAD' ||
    response.redirect ||
    status === 204 ||
    status === 205 ||
    status === 304 ||
    response.body === undefined ||
    response.body === null
  )
    return 'empty';

  if (isReadable(response.body))
    return 'stream';

  if (isBinary(response.body))
    return 'buffer';

  if (typeof response.body === 'string')
    return 'text';

  return 'json';
}

/**
 * Return a redacted response snapshot for logs, events, and replay artifacts.
 *
 * The snapshot keeps response shape and status visible without exposing body
 * content or cookie/header values.
 *
 * @param {object} response - Cricket response object.
 * @param {object} [options]
 * @param {string} [options.method] - Request method for wire-level body rules.
 * @returns {object} Safe response summary.
 */
export function safeResponseSnapshot(response = {}, options = {}) {
  return {
    status: statusFor(response),
    headers: Object.keys(response.headers ?? {}).map(name => name.toLowerCase()).sort(),
    cookies: responseCookieNames(response),
    redirected: Boolean(response.redirect),
    body: responseBodyKind(response, options)
  };
}

/**
 * Observe transport termination at ingress and own every response attempt.
 * Writing starts synchronously so preparation failures can still produce an
 * error response. Completion is joined separately after that response path.
 */
function hasConnectionToken(value, token) {
  let values = Array.isArray(value) ? value : [value];
  return values.some(value => String(value ?? '')
    .split(',')
    .some(part => part.trim().toLowerCase() === token));
}

export function createResponseWriter(req, res, {
  onCloseAfterCurrent
} = {}) {
  let terminal;
  let end;
  let terminated = new Promise(resolve => { end = resolve; });
  let pending = [];
  let socket = req.socket;
  let requestWantsClose = !res.shouldKeepAlive ||
    hasConnectionToken(req.headers?.connection, 'close');

  function terminate(kind) {
    if (terminal)
      return;

    terminal = kind;
    end(kind);
  }

  let onFinish = () => terminate('finished');
  let onClose = () => terminate(res.writableFinished ? 'finished' : 'closed');
  let onAbort = () => terminate('closed');
  req.once('aborted', onAbort);
  req.once('error', onAbort);
  res.once('finish', onFinish);
  res.once('close', onClose);
  res.once('error', onAbort);

  if (res.destroyed || req.aborted)
    terminate('closed');
  else if (res.writableFinished)
    terminate('finished');

  function own(promise) {
    let owned = Promise.resolve(promise);
    // A handler may still be running when transport cleanup rejects.
    void owned.catch(() => {});
    pending.push(owned);
  }

  function discard(body) {
    if (!isReadable(body))
      return;

    let completion = finished(body, { cleanup: true }).catch(error => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE')
        throw error;
    });
    own(completion);
    body.destroy();
  }

  function discardRequest(maxBodyBytes) {
    if (req.complete)
      return Promise.resolve('end');

    if (req.destroyed || req.aborted)
      return Promise.resolve('aborted');

    let bytes = requestBodyBytes(req);
    if (bytes > maxBodyBytes) {
      req.pause();
      return Promise.resolve('limit');
    }

    return new Promise(resolve => {
      let settled = false;

      function finish(reason) {
        if (settled)
          return;

        settled = true;
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('aborted', onAbort);
        req.off('close', onClose);
        req.off('error', onError);
        socket?.off('close', onSocketClose);
        resolve(reason);
      }

      let onData = chunk => {
        recordRequestBodyBytes(req, chunk.length);
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          req.pause();
          finish('limit');
        }
      };
      let onEnd = () => finish('end');
      let onAbort = () => finish('aborted');
      let onClose = () => {
        if (!req.complete)
          finish('aborted');
      };
      let onError = () => finish('aborted');
      let onSocketClose = () => finish('aborted');

      req.on('data', onData);
      req.once('end', onEnd);
      req.once('aborted', onAbort);
      req.once('close', onClose);
      req.once('error', onError);
      socket?.once('close', onSocketClose);

      if (req.complete)
        finish('end');
      else if (requestBodyBytes(req) > maxBodyBytes) {
        req.pause();
        finish('limit');
      } else
        req.resume();
    });
  }

  function closeAfterRequest(drain, finishKind) {
    let cleanup = Promise.all([terminated, drain]).then(([responseKind, bodyKind]) => {
      if (responseKind !== 'finished' || socket?.destroyed)
        return;

      if (bodyKind === 'limit')
        socket.destroy();
      else if (finishKind)
        socket.end();
    });
    own(cleanup);
  }

  function drainRequest(maxBodyBytes = defaultMaxBodyBytes) {
    let drain = discardRequest(maxBodyBytes);
    own(drain.then(reason => {
      if (reason !== 'limit') return;
      return terminated.then(kind => {
        if (kind === 'finished' && !socket?.destroyed)
          socket.destroy();
      });
    }));
    return drain;
  }

  function cleanup(response, immediately = false) {
    if (typeof response?.onClose === 'function')
      own((immediately ? Promise.resolve() : terminated).then(() => response.onClose()));
  }

  function observeTerminal(onTerminal) {
    if (onTerminal)
      own(terminated.then(onTerminal));
  }

  function write(response, {
    onTerminal,
    maxBodyBytes,
    declineRequestBody = false,
    skipRequestDrain = false
  } = {}) {
    let prepared;

    try {
      prepared = prepareResponse(response);
      assertValidStatus(prepared.status);
      assertValidHeaders(prepared.headers);
    } catch (error) {
      cleanup(response, true);
      discard(response?.body);
      throw error;
    }

    cleanup(response);

    observeTerminal(onTerminal);

    if (terminal === 'closed') {
      discard(response?.body);
      return;
    }

    let responseWantsClose = Object.entries(prepared.headers).some(([name, value]) =>
      name.toLowerCase() === 'connection' && hasConnectionToken(value, 'close'));
    let drain;
    let closeCurrent = requestWantsClose || responseWantsClose;
    let incompleteRequest = !req.complete && !req.destroyed;
    let declinedBody = incompleteRequest && declineRequestBody;
    let deferredBody = incompleteRequest && skipRequestDrain;

    if (incompleteRequest && (closeCurrent || declinedBody || deferredBody))
      onCloseAfterCurrent?.();

    res.statusCode = prepared.status;
    for (let [name, value] of Object.entries(prepared.headers))
      res.setHeader(name, value);

    if (declinedBody) {
      res.shouldKeepAlive = false;
      res.setHeader('connection', 'close');
    } else if (deferredBody) {
      res.shouldKeepAlive = false;
      res.setHeader('connection', 'close');
    } else if (incompleteRequest) {
      // Keep the response alive until the request body is drained. Node closes
      // a response marked Connection: close as soon as its response bytes flush.
      res.shouldKeepAlive = true;
      res.setHeader('connection', 'keep-alive');

      if (!req.complete && !req.destroyed) {
        drain = discardRequest(maxBodyBytes ?? defaultMaxBodyBytes);
        own(drain);
        own(drain.then(reason => {
          if (reason === 'limit')
            return terminated.then(kind => {
              if (kind === 'finished' && !socket?.destroyed)
                socket.destroy();
            });
        }));
      } else
        drain = Promise.resolve('end');

      if (closeCurrent)
        closeAfterRequest(drain, true);
    } else if (closeCurrent) {
      onCloseAfterCurrent?.();
      res.shouldKeepAlive = false;
      res.setHeader('connection', 'close');
    }

    let noBody = response?.redirect || [204, 205, 304].includes(prepared.status);
    if (noBody || req.method === 'HEAD') {
      discard(response?.body);
      if (noBody) {
        res.removeHeader('content-length');
        res.removeHeader('content-type');
        res.removeHeader('transfer-encoding');
      }
      res.end();
      return;
    }

    if (prepared.body.kind !== 'stream') {
      res.end(prepared.body.body);
      return;
    }

    let body = prepared.body.body;
    let producerError;
    let onError = error => {
      if (terminal !== 'closed') producerError = error;
    };
    body.on('error', onError);
    let streams = prepared.streamLength === undefined
      ? [body, res]
      : [body, checkStreamLength(prepared.streamLength), res];
    own(pipeline(streams).catch(error => {
      if (producerError)
        throw producerError;
      if (terminal !== 'closed' || !['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ABORT_ERR'].includes(error.code))
        throw error;
    }).finally(() => body.off('error', onError)));
  }

  async function complete() {
    try {
      await terminated;
      let results = await Promise.allSettled(pending);
      let errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Response completion failed');
    } finally {
      req.off('aborted', onAbort);
      req.off('error', onAbort);
      res.off('finish', onFinish);
      res.off('close', onClose);
      res.off('error', onAbort);
    }
  }

  return { write, complete, drainRequest, observeTerminal };
}
