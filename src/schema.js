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
 * Strip JSON Schema dialect metadata from generated output so Cricket returns
 * the lean schema shape callers expect.
 *
 * @param {any} schema
 * @returns {any}
 */
function withoutSchemaDialect(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return schema;

  let { $schema, ...rest } = schema;
  return rest;
}

/**
 * Convert a Zod schema or plain JSON Schema into a JSON Schema-like object.
 *
 * @param {any} schema
 * @returns {any}
 */
export function toJsonSchema(schema) {
  if (!schema) return undefined;

  if (isZodSchema(schema))
    return withoutSchemaDialect(z.toJSONSchema(schema, { io: 'input' }));

  return schema;
}
