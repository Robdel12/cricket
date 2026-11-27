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

function jobRunIdFor(log) {
  return log?.jobRunId ?? log?.metadata?.jobRunId ?? log?.span?.context?.jobRunId;
}

function routeNameFor(log) {
  let route = log.route ?? log.metadata?.route;

  if (typeof route === 'string')
    return route;

  return route?.operationId ?? route?.path;
}

function firstDefined(...values) {
  for (let value of values) {
    if (value !== undefined && value !== null && value !== '')
      return value;
  }

  return undefined;
}

function objectValue(value) {
  return value && typeof value === 'object' ? value : undefined;
}

function requestSummary(log) {
  let request = log.metadata?.request ?? {};
  let response = log.metadata?.response ?? {};
  let { jobName, jobRunId, envelopeId, attempt, availableAt } = log.metadata ?? {};
  let parts = [
    log.time,
    log.level?.toUpperCase(),
    log.event,
    routeNameFor(log),
    request.method,
    request.path,
    response.status ? `status=${response.status}` : undefined,
    jobName,
    jobRunId,
    attempt ? `attempt=${attempt}` : undefined,
    envelopeId ? `job=${envelopeId}` : undefined,
    availableAt ? `availableAt=${availableAt}` : undefined
  ];

  return parts.filter(Boolean).join(' ');
}

function isSpanLog(log) {
  return Boolean(spanFor(log));
}

function spanFor(log) {
  let metadataSpan = objectValue(log?.metadata?.span);
  let topLevelSpan = objectValue(log?.span);

  if (!metadataSpan && !topLevelSpan)
    return undefined;

  return {
    ...metadataSpan,
    ...topLevelSpan
  };
}

function durationLabelFor(span) {
  if (span?.durationMs === undefined)
    return undefined;

  return `${span.durationMs}ms`;
}

function statusLabelFor(span) {
  if (span?.status === undefined)
    return undefined;

  return `status=${span.status}`;
}

function errorLabelFor(span) {
  let error = span?.error;

  if (!error)
    return undefined;

  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean')
    return `error=${error}`;

  if (typeof error === 'object') {
    let message = firstDefined(error.code, error.name);

    if (message !== undefined)
      return `error=${message}`;
  }

  return undefined;
}

function spanSummary(log, span) {
  let parts = [
    log.time,
    log.level?.toUpperCase(),
    log.event,
    firstDefined(span.name, span.id, log.event),
    durationLabelFor(span),
    statusLabelFor(span),
    errorLabelFor(span)
  ];

  return parts.filter(Boolean).join(' ');
}

/**
 * Build a lightweight parent/child tree from span log records.
 *
 * Logs may arrive as flat newline-delimited JSON, so the CLI reconstructs span
 * nesting from ids at render time instead of requiring a richer storage format.
 *
 * @param {object[]} logs
 * @returns {object[]}
 */
function createTimelineNodes(logs) {
  let nodes = [];

  for (let log of logs) {
    let span = spanFor(log);

    if (span) {
      nodes.push({
        children: [],
        kind: 'span',
        log,
        parentId: span?.parentId,
        span,
        spanId: span?.id
      });
      continue;
    }

    nodes.push({
      children: [],
      kind: 'log',
      log
    });
  }

  let spanNodesById = new Map();

  for (let node of nodes) {
    if (node.kind === 'span' && node.spanId !== undefined && node.spanId !== null)
      spanNodesById.set(node.spanId, node);
  }

  let roots = [];

  for (let node of nodes) {
    if (node.kind !== 'span') {
      roots.push(node);
      continue;
    }

    let parentId = node.parentId;
    let parent = parentId !== undefined && parentId !== null ? spanNodesById.get(parentId) : undefined;

    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  return roots;
}

/**
 * Render one trace node while guarding against malformed span cycles.
 *
 * Span ids come from logs, not trusted in-memory objects, so the `seen` set keeps
 * a bad or duplicated parent id from making terminal rendering loop forever.
 *
 * @param {object} node
 * @param {number} depth
 * @param {Set<string>} seen
 * @returns {string[]}
 */
function renderTimelineNode(node, depth, seen) {
  let indent = '  '.repeat(depth);

  if (node.kind === 'log')
    return [`${indent}${requestSummary(node.log)}`];

  if (node.spanId !== undefined && seen.has(node.spanId))
    return [];

  if (node.spanId !== undefined)
    seen.add(node.spanId);

  let lines = [`${indent}${spanSummary(node.log, node.span)}`];

  for (let child of node.children)
    lines.push(...renderTimelineNode(child, depth + 1, seen));

  return lines;
}

function formatLifecycleTrace(logs, id) {
  return [
    `Trace ${id}`,
    ...logs.map(log => `  ${requestSummary(log)}`)
  ].join('\n');
}

function formatTimelineTrace(logs, id) {
  let roots = createTimelineNodes(logs);
  let lines = [`Trace ${id}`];
  let seen = new Set();

  for (let node of roots)
    lines.push(...renderTimelineNode(node, 1, seen));

  return lines.join('\n');
}

/**
 * Find the request and related jobs by a request ID or job run ID.
 *
 * @param {string} input - Newline-delimited JSON logs.
 * @param {string} id - Request ID or job run ID.
 * @returns {object[]} Matching structured log entries.
 */
export function traceLogs(input, id) {
  let logs = input.split(/\r?\n/).map(parseJsonLine).filter(Boolean);
  let linkedJob = logs.find(log => {
    if (jobRunIdFor(log) !== id)
      return false;

    let requestId = requestIdFor(log);
    return requestId && requestId !== id;
  });
  let requestId = requestIdFor(linkedJob) ?? id;
  return logs.filter(log => requestIdFor(log) === requestId || jobRunIdFor(log) === id);
}

/**
 * Format a trace for terminal output.
 *
 * @param {object[]} logs - Matching structured log entries.
 * @param {string} id - Request ID or job run ID used for the lookup.
 * @returns {string} Human-readable trace.
 */
export function formatTrace(logs, id) {
  if (!logs.length)
    return `No Cricket logs found for ${id}`;

  if (logs.some(isSpanLog))
    return formatTimelineTrace(logs, id);

  return formatLifecycleTrace(logs, id);
}
