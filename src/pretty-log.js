import { inspect, isDeepStrictEqual } from 'node:util';

let levelColors = { debug: 90, info: 36, warn: 33, error: 31 };
let correlationKeys = new Set(['requestId', 'jobRunId', 'envelopeId', 'scheduleKey', 'scheduledFor']);

function paint(value, code, color) {
  return color ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function objectFields(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function without(fields, keys) {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => value !== undefined && !keys.includes(key))
  );
}

function addDetails(details, key, fields) {
  if (Object.keys(fields).length)
    details[key] = fields;
  else
    delete details[key];
}

function valueLabel(value) {
  if (typeof value === 'string' && value.length && !/[\s=\x00-\x1f\x7f-\x9f]/.test(value))
    return value;

  return inspect(value, { depth: null, breakLength: 88, maxArrayLength: null, maxStringLength: null });
}

function formatDetails(details, color) {
  let lines = [];
  let inline = [];
  let width = 0;
  let flush = () => {
    if (inline.length)
      lines.push(`  ${inline.join('  ')}`);
    inline = [];
    width = 0;
  };

  let entries = Object.entries(details);
  let ordered = [
    ...entries.filter(([key]) => !correlationKeys.has(key)),
    ...entries.filter(([key]) => correlationKeys.has(key))
  ];

  for (let [key, value] of ordered) {
    if (value === undefined)
      continue;

    let label = valueLabel(value);
    let field = `${key}=${label}`;

    if ((value !== null && typeof value === 'object') || label.includes('\n') || field.length > 88) {
      flush();
      lines.push(`  ${paint(`${key}:`, 90, color)} ${label.replaceAll('\n', '\n  ')}`);
      continue;
    }

    if (width + field.length + 2 > 88)
      flush();

    inline.push(`${paint(`${key}=`, 90, color)}${label}`);
    width += field.length + 2;
  }

  flush();
  return lines;
}

/** Render the already-redacted envelope for a person reading a terminal. */
export function formatPrettyLog(envelope, { color = false } = {}) {
  let metadata = envelope.metadata;
  let details = { ...metadata };
  let summary = [];
  let request = objectFields(metadata.request);
  let response = objectFields(metadata.response);
  let route = metadata.route;
  let span = objectFields(metadata.span);

  if (metadata.jobName !== undefined) {
    summary.push(valueLabel(metadata.jobName));
    delete details.jobName;
  }

  if (request.method !== undefined && request.path !== undefined) {
    summary.push(`${valueLabel(request.method)} ${valueLabel(request.path)}`);
    addDetails(details, 'request', without(request, ['method', 'path']));
  }

  if (route) {
    let key = route.operationId ? 'operationId' : 'path';
    let name = typeof route === 'string' ? route : route[key];
    if (name) {
      summary.push(valueLabel(name));
      if (typeof route === 'string')
        delete details.route;
      else
        addDetails(details, 'route', without(route, [key]));
    }
  }

  if (response.status !== undefined) {
    summary.push(String(response.status));
    addDetails(details, 'response', without(response, ['status']));
  }

  if (envelope.event === 'trace.span.finished' && Object.keys(span).length) {
    if (span.name !== undefined)
      summary.push(valueLabel(span.name));
    if (span.durationMs !== undefined)
      summary.push(`${span.durationMs}ms`);
    if (span.status !== undefined)
      summary.push(valueLabel(span.status));

    let remaining = without(span, ['name', 'durationMs', 'status']);
    let context = Object.fromEntries(Object.entries(objectFields(span.context))
      .filter(([key, value]) => !isDeepStrictEqual(value, metadata[key])));
    addDetails(remaining, 'context', context);
    addDetails(details, 'span', remaining);
  }

  // Job traces use the run ID as their request ID when no HTTP request exists.
  if (metadata.requestId === metadata.jobRunId)
    delete details.requestId;

  let header = [
    paint(envelope.time.slice(11), 90, color),
    paint(envelope.level.toUpperCase().padEnd(5), levelColors[envelope.level], color),
    envelope.service ? paint(`[${envelope.service}]`, 90, color) : undefined,
    paint(envelope.event, 1, color),
    summary.length ? `· ${summary.join(' · ')}` : undefined
  ].filter(Boolean).join(' ');

  return [header, ...formatDetails(details, color)].join('\n');
}
