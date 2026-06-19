function copyPlain(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object')
    return value;

  if (seen.has(value))
    return seen.get(value);

  if (Array.isArray(value)) {
    let copy = [];
    seen.set(value, copy);
    for (let item of value)
      copy.push(copyPlain(item, seen));
    return copy;
  }

  let copy = {};
  seen.set(value, copy);

  for (let [key, child] of Object.entries(value))
    copy[key] = copyPlain(child, seen);

  return copy;
}

/**
 * Recursively freeze an object graph in place.
 *
 * Use this when Cricket owns the object being frozen. For caller-owned values,
 * prefer `frozenPlain` so the original object is not mutated.
 *
 * @param {*} value - Value to freeze.
 * @param {WeakSet<object>} [seen] - Internal cycle tracker.
 * @returns {*} The original value, frozen when it is an object.
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value))
    return value;

  seen.add(value);

  for (let child of Object.values(value))
    deepFreeze(child, seen);

  return Object.freeze(value);
}

/**
 * Copy a plain object graph and recursively freeze the copy.
 *
 * This is Cricket's boundary helper for immutable contracts and inspection
 * snapshots. Functions and scalar values are preserved; arrays and plain object
 * containers are copied before freezing.
 *
 * @param {*} value - Value to copy and freeze.
 * @returns {*} Frozen plain copy of the value.
 */
export function frozenPlain(value) {
  return deepFreeze(copyPlain(value));
}
