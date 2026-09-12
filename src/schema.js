import { z } from 'zod';

/**
 * Detect whether a value is a Zod schema so Cricket can accept either schema
 * objects or already-serialized JSON Schema definitions at the boundary.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isZodSchema(value) {
  return Boolean(value?.safeParse);
}

/**
 * Parse a value with Zod and translate parse failures into Cricket errors.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {any} value
 * @param {(error: any) => Error} errorFactory
 * @returns {any}
 */
export function parseZod(schema, value, errorFactory) {
  if (!schema) return value;

  let result = schema.safeParse(value);
  if (!result.success)
    throw errorFactory(result.error);

  return result.data;
}

let unrepresentableTypes = new Set([
  'bigint', 'symbol', 'undefined', 'void', 'nan', 'custom', 'function',
  'transform', 'map', 'set', 'date'
]);

/**
 * Configure Zod conversion for request input or response output.
 * Mark unsupported types so metadata overrides can replace them before
 * toJsonSchema checks the finished schema. The override edits Zod's output.
 *
 * @param {'input'|'output'} io
 * @returns {object} Zod JSON Schema conversion options.
 */
function cricketJsonSchemaOptions(io) {
  return {
    io,
    unrepresentable: 'any',
    override({ zodSchema, jsonSchema }) {
      let definition = zodSchema._zod.def;
      let declared = zodSchema.meta?.()?.jsonSchema;
      delete jsonSchema.jsonSchema;
      delete jsonSchema.cricket;
      if (declared !== undefined) {
        if (!declared || typeof declared !== 'object' || Array.isArray(declared))
          throw new Error('jsonSchema metadata must be a JSON Schema object');
        for (let key of Object.keys(jsonSchema)) delete jsonSchema[key];
        for (let [key, value] of Object.entries(declared))
          Object.defineProperty(jsonSchema, key, { value, enumerable: true, configurable: true, writable: true });
        return;
      }
      if (definition.type === 'date' && io === 'output') {
        jsonSchema.type = 'string';
        jsonSchema.format = 'date-time';
        return;
      }
      if (io === 'input' && definition.coerce) {
        jsonSchema['x-cricket-unrepresentable'] = `${definition.type} coercion`;
        return;
      }
      let unsupportedLiteral = definition.type === 'literal' &&
        definition.values.some(value =>
          ['bigint', 'undefined', 'symbol'].includes(typeof value)
        );
      let preprocess = io === 'input' && definition.type === 'pipe' &&
        definition.in._zod.def.type === 'transform';
      if (unsupportedLiteral || unrepresentableTypes.has(definition.type) || preprocess) {
        jsonSchema['x-cricket-unrepresentable'] = definition.type;
      }
    }
  };
}

/**
 * Visit schema objects through properties, definitions, and nested schema keywords.
 * Skip example/default values and boolean schemas. A property named `examples`
 * still gets visited because its value is a schema, not example data.
 *
 * @param {object|boolean|undefined} schema
 * @param {(schema: object) => void} visit - Called before visiting child schemas.
 * @returns {void}
 */
export function visitJsonSchema(schema, visit) {
  if (!schema || typeof schema !== 'object') return;
  visit(schema);
  for (let key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    for (let child of Object.values(schema[key] ?? {})) visitJsonSchema(child, visit);
  }
  for (let key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    for (let child of schema[key] ?? []) visitJsonSchema(child, visit);
  }
  for (let key of ['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
    visitJsonSchema(schema[key], visit);
  }
}

function assertRepresentable(schema, io) {
  visitJsonSchema(schema, node => {
    let unsupported = node['x-cricket-unrepresentable'];
    if (typeof unsupported === 'string')
      throw new Error(`Cannot describe ${unsupported} as ${io} JSON Schema; declare jsonSchema metadata or use a representable schema`);
  });
}

/**
 * Convert a Zod schema or plain JSON Schema into a JSON Schema-like object.
 *
 * @param {any} schema
 * @returns {any}
 */
export function toJsonSchema(schema, { io = 'input' } = {}) {
  if (!schema) return undefined;

  if (!isZodSchema(schema)) return schema;

  let { $schema, ...result } = z.toJSONSchema(schema, cricketJsonSchemaOptions(io));
  assertRepresentable(result, io);
  return result;
}
