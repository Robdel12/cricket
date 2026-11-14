let protocolHostDefinitions = new WeakMap();

export function defineProtocolHost({ name, paths, matches, handle, close = async () => {} }) {
  if (
    typeof name !== 'string' || !name || typeof matches !== 'function' ||
    typeof handle !== 'function' || typeof close !== 'function' ||
    !Array.isArray(paths?.prefixes) || !Array.isArray(paths?.exact) ||
    [...paths.prefixes, ...paths.exact].some(path => typeof path !== 'string' || !path.startsWith('/'))
  )
    throw new Error('A Cricket protocol host needs a name, owned paths, matches, handle, and close functions');

  let host = Object.freeze({});
  protocolHostDefinitions.set(host, Object.freeze({
    name,
    paths: Object.freeze({
      prefixes: Object.freeze([...paths.prefixes]),
      exact: Object.freeze([...paths.exact])
    }),
    matches,
    handle,
    close
  }));
  return host;
}

export function protocolHostDefinition(host) {
  return protocolHostDefinitions.get(host);
}

export function protocolHostsOverlap(first, second) {
  let a = protocolHostDefinition(first)?.paths;
  let b = protocolHostDefinition(second)?.paths;
  if (!a || !b) return false;
  let overlapsPrefix = (prefix, path) => path === prefix || path.startsWith(`${prefix}/`);
  return a.prefixes.some(prefix =>
    b.prefixes.some(other => overlapsPrefix(prefix, other) || overlapsPrefix(other, prefix)) ||
    b.exact.some(path => overlapsPrefix(prefix, path))
  ) || b.prefixes.some(prefix => a.exact.some(path => overlapsPrefix(prefix, path))) ||
    a.exact.some(path => b.exact.includes(path));
}


export function protocolHostOverlapsEndpoint(host, endpointPath) {
  let owned = protocolHostDefinition(host)?.paths;
  if (!owned || typeof endpointPath !== 'string') return false;
  let endpointSegments = endpointPath.split('/').filter(Boolean);
  let mayMatch = (routeSegment, pathSegment) => routeSegment.startsWith(':') || routeSegment === pathSegment;
  let overlaps = (path, prefix) => {
    let pathSegments = path.split('/').filter(Boolean);
    if (prefix ? endpointSegments.length < pathSegments.length : endpointSegments.length !== pathSegments.length)
      return false;
    return pathSegments.every((segment, index) => mayMatch(endpointSegments[index], segment));
  };
  return owned.prefixes.some(path => overlaps(path, true)) || owned.exact.some(path => overlaps(path, false));
}
