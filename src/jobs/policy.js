function resolvedValue(value, context) {
  return typeof value === 'function' ? value(context) : value;
}

function assertConcurrencyKey(value, type) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${type} key must resolve to a non-empty string`);
}

function assertConcurrencyLimit(value, type) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${type} limit must resolve to a positive safe integer`);
}

/**
 * Resolve job concurrency functions while planning an immutable envelope.
 *
 * @param {object} job
 * @param {{ input: object, context: object }} context
 * @returns {object[]}
 */
export function resolveConcurrency(job, context) {
  let resolved = (job.concurrency ?? []).map(policy => {
    let key = resolvedValue(policy.key, context);
    let limit = resolvedValue(policy.limit, context);

    assertConcurrencyKey(key, policy.type);
    assertConcurrencyLimit(limit, policy.type);

    return {
      type: policy.type,
      key,
      limit
    };
  });
  let identities = new Set();

  for (let policy of resolved) {
    let identity = `${policy.type}:${policy.key}`;

    if (identities.has(identity))
      throw new Error(`Duplicate concurrency policy ${identity}`);

    identities.add(identity);
  }

  return resolved;
}

function matchingConstraints(envelope, constraint) {
  return envelope.concurrency?.filter(candidate =>
    candidate.type === constraint.type &&
    candidate.key === constraint.key
  ) ?? [];
}

/**
 * Return whether an envelope has capacity under every resolved constraint.
 *
 * Matching active envelopes may carry a stricter limit than the candidate, so
 * the effective limit is the smallest contract currently sharing that key.
 *
 * @param {object} envelope
 * @param {object[]} activeEnvelopes
 * @returns {boolean}
 */
export function canClaimEnvelope(envelope, activeEnvelopes) {
  return (envelope.concurrency ?? []).every(constraint => {
    let matching = activeEnvelopes
      .map(active => matchingConstraints(active, constraint))
      .filter(candidates => candidates.length);
    let limit = Math.min(
      constraint.limit,
      ...matching.flatMap(candidates => candidates.map(candidate => candidate.limit))
    );

    return matching.length < limit;
  });
}

function priorityFor(envelope) {
  return envelope.priority ?? 0;
}

/**
 * Order ready envelopes by priority, creation time, and stable envelope id.
 *
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
export function compareClaimOrder(left, right) {
  if (priorityFor(left) !== priorityFor(right))
    return priorityFor(left) > priorityFor(right) ? -1 : 1;

  return left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}
