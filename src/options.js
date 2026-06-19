/**
 * Reject unknown keys for small public option objects.
 *
 * Cricket builders intentionally keep option surfaces explicit. This guard
 * catches misspelled or unsupported keys before they become quiet runtime
 * behavior.
 *
 * @param {object} options - Options object supplied by app code.
 * @param {Set<string>} keys - Allowed option keys.
 * @param {string} type - Builder name used in the error message.
 * @returns {void}
 */
export function assertKnownOptions(options, keys, type) {
  let unknown = Object.keys(options).filter(key => !keys.has(key));

  if (unknown.length)
    throw new Error(`${type} received unknown option ${unknown.join(', ')}`);
}
