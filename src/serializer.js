/**
 * Compose multiple serializers into one shallow merged projection.
 *
 * @param  {...Function} serializers - Functions that accept `(value, ctx)` and
 * return plain objects.
 * @returns {Function} Serializer that merges every serializer result into one
 * object.
 */
export function composeSerializers(...serializers) {
  return (value, ctx) =>
    serializers.reduce((result, serialize) => ({
      ...result,
      ...serialize(value, ctx)
    }), {});
}

/**
 * Pick a fixed list of fields from a value and return them as a plain object.
 *
 * @param {string[]} fields - Field names to copy from the input value.
 * @returns {Function} Serializer that returns only the requested fields.
 */
export function pickFields(fields) {
  return value => Object.fromEntries(
    fields.map(field => [field, value[field]])
  );
}

/**
 * Map output keys from a serializer while preserving the values.
 *
 * @param {Function} mapKey - Maps an output key to its replacement name.
 * @param {Function} [serialize=(value) => value] - Base serializer to transform.
 * @returns {Function} Serializer that remaps keys in the returned object.
 */
export function mapKeys(mapKey, serialize = value => value) {
  return (value, ctx) => Object.fromEntries(
    Object.entries(serialize(value, ctx)).map(([key, fieldValue]) => [
      mapKey(key),
      fieldValue
    ])
  );
}

function toCamelCaseKey(key) {
  return key.replace(/[_-]([a-zA-Z0-9])/g, (_, letter) =>
    letter.toUpperCase()
  );
}

/**
 * Convert serialized object keys from snake_case or kebab-case to camelCase.
 *
 * Wrap a projection like `pickFields()` when only selected fields should leave
 * the API boundary.
 *
 * @param {Function} [serialize=(value) => value] - Base serializer to transform.
 * @returns {Function} Serializer with camelCased keys.
 */
export function camelCaseKeys(serialize) {
  return mapKeys(toCamelCaseKey, serialize);
}

/**
 * Rename fields from an input object into a new plain object shape.
 *
 * @param {object<string, string>} fields - Map of source keys to destination keys.
 * @returns {Function} Serializer that returns the renamed object.
 */
export function renameFields(fields) {
  return value => Object.fromEntries(
    Object.entries(fields).map(([from, to]) => [to, value[from]])
  );
}
