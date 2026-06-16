function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function requestIdFor(log) {
  return log?.requestId ?? log?.metadata?.requestId;
}

function routeNameFor(log) {
  let route = log.route ?? log.metadata?.route;

  if (typeof route === 'string')
    return route;

  return route?.operationId ?? route?.path;
}

function requestSummary(log) {
  let request = log.metadata?.request ?? {};
  let response = log.metadata?.response ?? {};
  let parts = [
    log.time,
    log.level?.toUpperCase(),
    log.event,
    routeNameFor(log),
    request.method,
    request.path,
    response.status ? `status=${response.status}` : undefined
  ];

  return parts.filter(Boolean).join(' ');
}

/**
 * Parse newline-delimited Cricket JSON logs and keep events for one request.
 *
 * @param {string} input - Raw log text, usually from stdin.
 * @param {string} requestId - Request id to trace.
 * @returns {object[]} Matching structured log entries.
 */
export function traceLogs(input, requestId) {
  return input
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(log => requestIdFor(log) === requestId);
}

/**
 * Format a request trace for terminal output.
 *
 * @param {object[]} logs - Structured log entries for one request.
 * @param {string} requestId - Request id being traced.
 * @returns {string} Human-readable trace.
 */
export function formatTrace(logs, requestId) {
  if (!logs.length)
    return `No Cricket logs found for ${requestId}`;

  return [
    `Trace ${requestId}`,
    ...logs.map(log => `  ${requestSummary(log)}`)
  ].join('\n');
}
