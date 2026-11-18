export function isPlainObject(value) {
  if (!value || typeof value !== 'object')
    return false;

  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number')
    return Number.isFinite(value);
  if (ancestors.has(value))
    return false;

  let children;
  if (Array.isArray(value)) {
    children = value.values();
  } else if (isPlainObject(value) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key)
  )) {
    children = Object.values(value).values();
  } else {
    return false;
  }

  ancestors.add(value);
  let valid = children.every(child => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
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
    Object.defineProperty(copy, key, { value: frozenPlainCopy(child, seen), enumerable: true });

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
