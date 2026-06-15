import {
  normalizeEndpointMethod
} from '../endpoint.js';
import { badRequest } from '../errors.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

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

export function endpointWithPrefix(endpoint, prefix) {
  assertValidEndpointPath(endpoint);

  return {
    ...endpoint,
    path: joinPaths(prefix, endpoint.path)
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
