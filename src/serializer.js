import { serializerContractFailed } from './errors.js';
import { parseZod } from './schema.js';

function parseOutput(schema, value) {
  return parseZod(schema, value, serializerContractFailed);
}

/**
 * Define a serializer as a pure projection with an enforced output contract.
 *
 * The returned value is still a plain function. Cricket only adds boundary
 * parsing so leaks and missing fields fail where output is shaped.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {import('zod').ZodTypeAny} config.output
 * @param {(value: any, ctx?: any) => any} config.serialize
 * @returns {Function & { serializerName: string, output: import('zod').ZodTypeAny }}
 */
export function defineSerializer({
  name,
  output,
  serialize
}) {
  if (!name) throw new Error('Serializer name is required');
  if (!output) throw new Error(`Serializer ${name} needs an output schema`);
  if (typeof serialize !== 'function')
    throw new Error(`Serializer ${name} needs a serialize function`);

  let serializer = (value, ctx) => parseOutput(output, serialize(value, ctx));

  Object.defineProperties(serializer, {
    serializerName: { value: name },
    output: { value: output }
  });

  return Object.freeze(serializer);
}

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
