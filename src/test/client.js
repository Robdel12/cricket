import { randomUUID } from 'node:crypto';

let testRequestIdHeader = 'x-cricket-test-request-id';
let bodylessMethods = new Set(['GET', 'HEAD']);

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

function requestBody(method, headers, options) {
  if (bodylessMethods.has(method))
    return undefined;

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
  let text = await response.text();
  let contentType = response.headers.get('content-type') ?? '';

  if (!isJsonContentType(contentType))
    return {
      body: undefined,
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

function isJsonContentType(contentType) {
  let mediaType = contentType.split(';')[0].trim().toLowerCase();

  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * Create a real HTTP client for a Cricket runtime.
 *
 * The client starts the runtime on a local ephemeral port and talks through
 * `fetch`, so tests exercise routing, validation, middleware, logging, tracing,
 * response writing, and Node's HTTP boundary.
 *
 * @param {object|Function} runtimeOrApp - Cricket runtime object or app handler.
 * @returns {Promise<object>} HTTP helpers plus `cleanup()`.
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

    let response = await fetch(url, {
      method,
      headers,
      body
    });
    let parsed = await parseBody(response);

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
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
