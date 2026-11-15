import { Readable, Transform } from 'node:stream';
import { badRequest, payloadTooLarge } from '../errors.js';
import { respond, withHeaders, withResponseCleanup } from '../response.js';
import { recordRequestBodyBytes } from './body-bytes.js';

let bodylessMethods = new Set(['GET', 'HEAD']);
let requestBodyQueueBytes = 64 * 1024;
let hopByHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade'
]);

function connectionTokens(headers) {
  return String(headers.get('connection') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
}

function requestHeaders(req) {
  let headers = new Headers();
  let excluded = new Set([...hopByHopHeaders, ...connectionTokens(new Headers(req.headers))]);
  for (let [name, value] of Object.entries(req.headers)) {
    if (excluded.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (let item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function requestBody(req, maxBytes) {
  let size = 0;
  let failure;
  let limiter = new Transform({
    transform(chunk, _encoding, callback) {
      let bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      size += bytes;
      recordRequestBodyBytes(req, bytes);
      if (size > maxBytes) {
        failure = payloadTooLarge(`Request body exceeds ${maxBytes} bytes`, { maxBytes });
        req.pause();
        req.unpipe(limiter);
        callback(failure);
        return;
      }
      callback(null, chunk);
    }
  });
  let onError = error => limiter.destroy(error);
  req.once('error', onError);
  req.pipe(limiter);
  let stream = Readable.toWeb(limiter, {
    strategy: {
      highWaterMark: requestBodyQueueBytes,
      size: chunk => chunk.byteLength
    }
  });
  return {
    stream,
    failure() { return failure; },
    cleanup() {
      req.off('error', onError);
      if (!req.complete && !req.destroyed) req.unpipe(limiter);
      if (!limiter.destroyed) limiter.destroy();
      return failure;
    }
  };
}

export function createFetchRequest(req, cricketRequest, { maxBodyBytes, signal }) {
  let method = cricketRequest.method.toUpperCase();
  let contentLength = Number(req.headers['content-length'] ?? 0);
  let hasBody = contentLength > 0 || req.headers['transfer-encoding'] !== undefined;
  if (bodylessMethods.has(method) && hasBody)
    throw badRequest(`${method} Fetch requests cannot carry a body`);

  let target = new URL(cricketRequest.url, cricketRequest.origin);
  let url = new URL(`${target.pathname}${target.search}`, cricketRequest.origin);
  let source = hasBody ? requestBody(req, maxBodyBytes) : undefined;
  try {
    let request = new Request(url, {
      method,
      headers: requestHeaders(req),
      ...(source ? { body: source.stream, duplex: 'half' } : {}),
      signal
    });
    return {
      request,
      hasBody,
      failure: () => source?.failure(),
      cleanup: () => source?.cleanup()
    };
  } catch (error) {
    source?.cleanup();
    throw error;
  }
}

export function fetchResponseToHttpResponse(response, { signal } = {}) {
  if (!(response instanceof Response))
    throw new Error('Fetch endpoint must return a Fetch Response');
  let headers = {};
  let excluded = new Set([...hopByHopHeaders, ...connectionTokens(response.headers)]);
  for (let [name, value] of response.headers) {
    if (!excluded.has(name.toLowerCase())) headers[name] = value;
  }
  let setCookies = response.headers.getSetCookie?.();
  if (setCookies?.length) headers['set-cookie'] = setCookies;
  let body = response.body
    ? Readable.fromWeb(response.body)
    : undefined;
  let onAbort = () => body?.destroy();
  if (body && signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let httpResponse = withHeaders(respond(response.status, body), headers);
  if (body && signal) {
    httpResponse = withResponseCleanup(httpResponse, () => {
      signal.removeEventListener('abort', onAbort);
    });
  }
  return httpResponse;
}
