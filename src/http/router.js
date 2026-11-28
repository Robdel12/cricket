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

function compileSegment(segment) {
  let names = [];
  let literals = [];
  let lastIndex = 0;

  for (let match of segment.matchAll(/:([A-Za-z0-9_]+)/g)) {
    literals.push(segment.slice(lastIndex, match.index));
    names.push(match[1]);
    lastIndex = match.index + match[0].length;
  }

  if (!names.length)
    return segment;
  literals.push(segment.slice(lastIndex));
  return { names, literals };
}

function pathSegments(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/')
    end -= 1;
  return (path.slice(0, end) || '/').split('/');
}

function compilePath(path) {
  let segments = pathSegments(String(path)).map(compileSegment);
  return { segments, names: segments.flatMap(segment => segment.names ?? []) };
}

function matchSegment(value, { names, literals }) {
  let prefix = literals[0];
  let suffix = literals.at(-1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix))
    return;

  let captures = new Array(names.length);
  let end = value.length - suffix.length;
  // Take the rightmost possible separators so the earlier captures stay greedy.
  for (let index = captures.length - 1; index > 0; index--) {
    let literal = literals[index];
    let latest = end - literal.length - 1;
    if (latest < prefix.length)
      return;
    let start = value.lastIndexOf(literal, latest);
    if (start < prefix.length)
      return;
    captures[index] = value.slice(start + literal.length, end);
    end = start;
  }
  if (end <= prefix.length)
    return;
  captures[0] = value.slice(prefix.length, end);
  return captures;
}

function matchPath({ segments }, parts) {
  if (segments.length !== parts.length)
    return;

  let captures = [];
  for (let [index, segment] of segments.entries()) {
    let value = parts[index];
    if (typeof segment === 'string') {
      if (segment !== value) return;
    } else {
      let matched = matchSegment(value, segment);
      if (!matched) return;
      captures.push(...matched);
    }
  }
  return captures;
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
 * Prepare endpoints for routing by compiling path segments and sorting by specificity.
 *
 * Static segments are matched before parameterized ones.
 *
 * @param {Array<object>} endpoints - Endpoint contracts with `method` and `path`.
 * @returns {Array<{endpoint: object, method: string, match: object, score: object}>} Prepared routes.
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
  let parts = pathSegments(request.path);
  let exactMatch = findRouteMatch(routes, {
    method,
    parts
  });

  if (exactMatch)
    return exactMatch;

  if (method === 'HEAD') {
    return findRouteMatch(routes, {
      method: 'GET',
      parts
    });
  }

  return undefined;
}

function findRouteMatch(routes, {
  method,
  parts
}) {
  for (let route of routes) {
    if (route.method !== method)
      continue;

    let match = matchPath(route.match, parts);
    if (!match)
      continue;

    return {
      endpoint: route.endpoint,
      params: Object.fromEntries(route.match.names.map((name, index) => [
        name,
        decodeParam(match[index])
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
  let parts = pathSegments(request.path);
  let methods = new Set();

  for (let route of routes) {
    if (!matchPath(route.match, parts))
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
