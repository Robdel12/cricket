function isPlainObject(value) {
  if (!value || typeof value !== 'object')
    return false;

  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function frozenPlainCopy(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object')
    return value;

  if (!Array.isArray(value) && !isPlainObject(value))
    return value;

  if (seen.has(value))
    return seen.get(value);

  if (Array.isArray(value)) {
    let copy = [];
    seen.set(value, copy);
    for (let item of value)
      copy.push(frozenPlainCopy(item, seen));
    return Object.freeze(copy);
  }

  let copy = {};
  seen.set(value, copy);

  for (let [key, child] of Object.entries(value))
    copy[key] = frozenPlainCopy(child, seen);

  return Object.freeze(copy);
}

/**
 * Copy a plain object graph and recursively freeze the copy.
 *
 * This is Cricket's boundary helper for immutable contracts and inspection
 * snapshots. Functions and scalar values are preserved; arrays and plain object
 * containers are copied before freezing. Non-plain objects are opaque values:
 * Cricket preserves their identity and does not freeze caller-owned instances.
 *
 * @param {*} value - Value to copy and freeze.
 * @returns {*} Frozen plain copy of the value.
 */
export function frozenPlain(value) {
  return frozenPlainCopy(value);
}
