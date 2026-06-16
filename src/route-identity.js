/**
 * Return the stable operation id for an endpoint.
 *
 * Explicit endpoint operation IDs win; otherwise Cricket derives the same name
 * used by OpenAPI, inspect output, and runtime observability.
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
