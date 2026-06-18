import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

let testRequestIdHeader = 'x-cricket-test-request-id';
let bodylessMethods = new Set(['GET', 'HEAD']);
let bodyOptionNames = [
  'body',
  'buffer',
  'formData',
  'text'
];
let testFetch = globalThis.fetch.bind(globalThis);

function listen(app) {
  return new Promise((resolve, reject) => {
    let server = app.listen(0, '127.0.0.1');

    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function runtimeApp(runtimeOrApp) {
  if (typeof runtimeOrApp?.app?.listen === 'function')
    return runtimeOrApp.app;

  if (typeof runtimeOrApp?.listen === 'function')
    return runtimeOrApp;

  throw new Error('createTestClient requires a Cricket runtime or app');
}

function appendQuery(url, query) {
  if (!query)
    return;

  let entries = query instanceof URLSearchParams
    ? query.entries()
    : Object.entries(query);

  for (let [key, value] of entries) {
    if (Array.isArray(value)) {
      for (let item of value)
        url.searchParams.append(key, item);

      continue;
    }

    if (value !== undefined)
      url.searchParams.append(key, value);
  }
}

function hasHeader(headers, name) {
  let lowerName = name.toLowerCase();

  return Object.keys(headers).some(header => header.toLowerCase() === lowerName);
}

function hasBodyOption(options) {
  return bodyOptionNames.some(name => Object.hasOwn(options, name));
}

function requestBody(method, headers, options) {
  if (bodylessMethods.has(method)) {
    if (hasBodyOption(options))
      throw new Error(`${method} requests cannot include a body`);

    return undefined;
  }

  if (Object.hasOwn(options, 'formData'))
    return options.formData;

  if (Object.hasOwn(options, 'buffer'))
    return options.buffer;

  if (Object.hasOwn(options, 'text')) {
    if (!hasHeader(headers, 'content-type'))
      headers['content-type'] = 'text/plain; charset=utf-8';

    return options.text;
  }

  if (Object.hasOwn(options, 'body')) {
    if (!hasHeader(headers, 'content-type'))
      headers['content-type'] = 'application/json';

    return JSON.stringify(options.body);
  }

  return undefined;
}

async function parseBody(response) {
  let buffer = Buffer.from(await response.arrayBuffer());
  let text = buffer.toString('utf8');
  let contentType = response.headers.get('content-type') ?? '';

  if (!isJsonContentType(contentType))
    return {
      body: buffer,
      text
    };

  try {
    return {
      body: text ? JSON.parse(text) : undefined,
      text
    };
  } catch {
    return {
      body: undefined,
      text
    };
  }
}

function responseHeaders(response) {
  let headers = Object.fromEntries(response.headers.entries());
  let setCookie = response.headers.getSetCookie?.();

  if (setCookie?.length)
    headers['set-cookie'] = setCookie;

  return headers;
}

function isJsonContentType(contentType) {
  let mediaType = contentType.split(';')[0].trim().toLowerCase();

  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * @typedef {object} CricketTestRequestOptions
 * @property {object} [headers] - Request headers sent through Node's HTTP stack.
 * @property {object|URLSearchParams} [query] - Query params appended to the request path.
 * @property {object} [body] - JSON body. Cricket sets `content-type` when needed.
 * @property {FormData} [formData] - Multipart/form body.
 * @property {Buffer|Uint8Array|string} [buffer] - Raw request body.
 * @property {string} [text] - Plain-text request body.
 * @property {string} [requestId] - Stable id used to correlate response, logs, and trace events.
 * @property {RequestRedirect} [redirect='manual'] - Fetch redirect behavior.
 */

/**
 * @typedef {object} CricketTestResponse
 * @property {number} status
 * @property {object} headers
 * @property {*} body - Parsed JSON for JSON responses, otherwise a Buffer.
 * @property {string} text - UTF-8 response text for assertions and debugging.
 * @property {string} requestId - Request id attached by the test client.
 */

/**
 * @typedef {object} CricketTestClient
 * @property {(method: string, path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} request
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} get
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} post
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} put
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} patch
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} delete
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} head
 * @property {(path: string, options?: CricketTestRequestOptions) => Promise<CricketTestResponse>} options
 * @property {() => Promise<void>} cleanup
 */

/**
 * Create a real HTTP client for a Cricket runtime.
 *
 * The client starts the runtime on a local ephemeral port and talks through
 * `fetch`, so tests exercise routing, validation, middleware, logging, tracing,
 * response writing, and Node's HTTP boundary.
 *
 * @param {object|Function} runtimeOrApp - Cricket runtime object or app handler.
 * @returns {Promise<CricketTestClient>} HTTP helpers plus `cleanup()`.
 */
export async function createTestClient(runtimeOrApp) {
  let server = await listen(runtimeApp(runtimeOrApp));
  let { port } = server.address();
  let origin = `http://127.0.0.1:${port}`;

  async function request(method, path, options = {}) {
    method = method.toUpperCase();

    let requestId = options.requestId ?? `test_${randomUUID()}`;
    let url = new URL(path, origin);
    let headers = {
      ...(options.headers ?? {}),
      [testRequestIdHeader]: requestId
    };
    let body = requestBody(method, headers, options);

    appendQuery(url, options.query);

    let response = await testFetch(url, {
      method,
      headers,
      body,
      redirect: options.redirect ?? 'manual'
    });
    let parsed = await parseBody(response);

    return {
      status: response.status,
      headers: responseHeaders(response),
      body: parsed.body,
      text: parsed.text,
      requestId
    };
  }

  return {
    request,
    get(path, options) {
      return request('GET', path, options);
    },
    post(path, options) {
      return request('POST', path, options);
    },
    put(path, options) {
      return request('PUT', path, options);
    },
    patch(path, options) {
      return request('PATCH', path, options);
    },
    delete(path, options) {
      return request('DELETE', path, options);
    },
    head(path, options) {
      return request('HEAD', path, options);
    },
    options(path, options) {
      return request('OPTIONS', path, options);
    },
    cleanup() {
      return close(server);
    }
  };
}

export {
  testRequestIdHeader
};
