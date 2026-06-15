import {
  normalizeEndpointMethod
} from '../endpoint.js';
import { badRequest } from '../errors.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

/**
 * Join path segments into a single normalized path.
 *
 * Removes leading/trailing slashes from each segment and joins with a single slash.
 * Used to construct endpoint paths with app-level prefixes.
 *
 * @param {...string} parts - Path segments to join.
 * @returns {string} Normalized path starting with /.
 */
export function joinPaths(...parts) {
  let path = parts
    .filter(Boolean)
    .map(part => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

  return `/${path}`;
}

function compilePath(path) {
  let names = [];
  let normalizedPath = String(path).replace(/\/+$/g, '') || '/';
  let parts = [];
  let lastIndex = 0;
  let paramPattern = /:([A-Za-z0-9_]+)/g;

  for (let match of normalizedPath.matchAll(paramPattern)) {
    parts.push(escapeRegex(normalizedPath.slice(lastIndex, match.index)));
    parts.push('([^/]+)');
    names.push(match[1]);
    lastIndex = match.index + match[0].length;
  }

  parts.push(escapeRegex(normalizedPath.slice(lastIndex)));

  return {
    names,
    regex: new RegExp(`^${parts.join('')}$`)
  };
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Prefix an endpoint's path with the app-level path prefix.
 *
 * Ensures the endpoint path starts and ends correctly with the prefix applied.
 *
 * @param {object} endpoint - Endpoint contract with `method` and `path`.
 * @param {string} prefix - App-level path prefix.
 * @returns {{ method: string, path: string, ...endpoint }} Endpoint with prefixed path.
 */
export function endpointWithPrefix(endpoint, prefix) {
  assertValidEndpointPath(endpoint);

  return {
    ...endpoint,
    path: joinPaths(prefix, endpoint.path),
    operationPath: endpoint.operationPath ?? endpoint.path
  };
}

/**
 * Return the stable operation id for an endpoint.
 *
 * Explicit endpoint operation IDs win; otherwise Cricket derives the same name
 * used by OpenAPI and runtime observability.
 *
 * @param {object} endpoint - Endpoint contract.
 * @returns {string} Stable operation id.
 */
export function operationIdFor(endpoint) {
  if (endpoint.operationId)
    return endpoint.operationId;

  let pathName = (endpoint.operationPath ?? endpoint.path)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+([A-Za-z0-9])/g, (_, letter) => letter.toUpperCase());

  return `${endpoint.method.toLowerCase()}${pathName.charAt(0).toUpperCase()}${pathName.slice(1)}`;
}

/**
 * Return the stable route identity shared by docs, inspect, and observability.
 *
 * @param {object} endpoint - Endpoint contract.
 * @returns {{method: string, path: string, operationId: string}}
 */
export function routeIdentityFor(endpoint) {
  return {
    method: endpoint.method,
    path: endpoint.path,
    operationId: operationIdFor(endpoint)
  };
}

function routeScore(path) {
  let segments = String(path)
    .split('/')
    .filter(Boolean);
  let staticSegments = segments.filter(segment => !segment.startsWith(':'));
  let paramSegments = segments.length - staticSegments.length;

  return {
    staticSegments: staticSegments.length,
    paramSegments,
    length: String(path).length
  };
}

function compareRouteSpecificity(left, right) {
  return right.score.staticSegments - left.score.staticSegments
    || left.score.paramSegments - right.score.paramSegments
    || right.score.length - left.score.length
    || left.index - right.index;
}

/**
 * Flatten a potentially nested array of endpoints into a single array.
 *
 * Used by the runtime to handle endpoints defined at app or domain level
 * with any combination of array or single values.
 *
 * @param {Array|any} values - Nested endpoint values.
 * @returns {Array<object>} Flat array of endpoint contracts.
 */
export function flattenRoutes(values) {
  return toArray(values).flatMap(value => {
    if (!value)
      return [];

    if (Array.isArray(value))
      return flattenRoutes(value);

    return [value];
  });
}

function assertValidEndpointPath(endpoint) {
  if (!String(endpoint.path).startsWith('/'))
    throw new Error(`${endpoint.method} ${endpoint.path} needs a path that starts with /`);
}

function routeKey(endpoint) {
  let method = normalizeEndpointMethod(endpoint.method);
  let path = String(endpoint.path).replace(/\/+$/g, '') || '/';

  return `${method} ${path}`;
}

function assertUniqueRoute(route, seen) {
  assertValidEndpointPath(route.endpoint);

  let key = routeKey(route.endpoint);

  if (seen.has(key))
    throw new Error(`Duplicate route ${key}`);

  seen.add(key);
}

/**
 * Prepare endpoints for routing by compiling paths and sorting by specificity.
 *
 * Creates route objects with compiled regex patterns for path matching and sorts
 * them so static segments are matched before parameterized ones.
 *
 * @param {Array<object>} endpoints - Endpoint contracts with `method` and `path`.
 * @returns {Array<{endpoint: object, method: string, match: {names: string[], regex: RegExp}, score: object}>} Prepared routes.
 */
export function prepareRoutes(endpoints = []) {
  let seen = new Set();

  return flattenRoutes(endpoints)
    .map((endpoint, index) => ({
      endpoint,
      index,
      method: normalizeEndpointMethod(endpoint.method),
      match: compilePath(endpoint.path),
      score: routeScore(endpoint.path)
    }))
    .map(route => {
      assertUniqueRoute(route, seen);
      return route;
    })
    .sort(compareRouteSpecificity);
}

/**
 * Match a request against prepared routes.
 *
 * Looks up the endpoint for a given method and path, handling HEAD-to-GET
 * fallback. Returns the matched endpoint and extracted path parameters.
 *
 * @param {Array} routes - Routes from prepareRoutes().
 * @param {object} request - Cricket request with `method` and `path`.
 * @returns {{endpoint: object, params: object}|undefined} Match result or undefined.
 */
export function matchRoute(routes, request) {
  let method = request.method.toUpperCase();
  let path = request.path.replace(/\/+$/g, '') || '/';
  let exactMatch = findRouteMatch(routes, {
    method,
    path
  });

  if (exactMatch)
    return exactMatch;

  if (method === 'HEAD') {
    return findRouteMatch(routes, {
      method: 'GET',
      path
    });
  }

  return undefined;
}

function findRouteMatch(routes, {
  method,
  path
}) {
  for (let route of routes) {
    if (route.method !== method)
      continue;

    let match = route.match.regex.exec(path);
    if (!match)
      continue;

    return {
      endpoint: route.endpoint,
      params: Object.fromEntries(route.match.names.map((name, index) => [
        name,
        decodeParam(match[index + 1])
      ]))
    };
  }

  return undefined;
}

/**
 * Get HTTP methods allowed for a given path.
 *
 * Scans prepared routes and returns methods that could match the path, plus HEAD
 * for any path that allows GET. Used for OPTIONS responses and 405 errors.
 *
 * @param {Array} routes - Routes from prepareRoutes().
 * @param {object} request - Cricket request with `path`.
 * @returns {string[]} Sorted array of allowed HTTP methods.
 */
export function allowedMethodsForPath(routes, request) {
  let path = request.path.replace(/\/+$/g, '') || '/';
  let methods = new Set();

  for (let route of routes) {
    if (!route.match.regex.exec(path))
      continue;

    methods.add(route.method);
  }

  if (methods.has('GET'))
    methods.add('HEAD');

  if (methods.size)
    methods.add('OPTIONS');

  return [...methods].sort();
}

function decodeParam(value) {
  try {
    let decoded = decodeURIComponent(value);

    if (/[\/\\\x00]/.test(decoded))
      throw badRequest('Invalid path parameter encoding');

    return decoded;
  } catch {
    throw badRequest('Invalid path parameter encoding');
  }
}
