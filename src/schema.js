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

/**
 * Strip generator-only metadata from generated output so OpenAPI does not leak
 * Zod dialect markers or Cricket field visibility hints.
 *
 * @param {any} schema
 * @returns {any}
 */
function withoutSchemaDialect(schema) {
  let { $schema, ...rest } = schema;
  return rest;
}

let unrepresentableTypes = new Set([
  'bigint', 'symbol', 'undefined', 'void', 'nan', 'custom', 'function',
  'transform', 'map', 'set', 'date'
]);

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
      if ((definition.type === 'literal' && definition.values.some(value => ['bigint', 'undefined', 'symbol'].includes(typeof value))) ||
          unrepresentableTypes.has(definition.type) ||
          (io === 'input' && definition.type === 'pipe' && definition.in._zod.def.type === 'transform')) {
        jsonSchema['x-cricket-unrepresentable'] = definition.type;
      }
    }
  };
}

// Visit schema positions only: a property named `examples` is still a schema,
// while example data is never interpreted as schema metadata.
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

  if (isZodSchema(schema)) {
    let result = withoutSchemaDialect(z.toJSONSchema(schema, cricketJsonSchemaOptions(io)));
    assertRepresentable(result, io);
    return result;
  }

  return schema;
}
