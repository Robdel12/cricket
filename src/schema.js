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
  if (!schema || typeof schema !== 'object')
    return schema;

  if (Array.isArray(schema))
    return schema.map(withoutSchemaDialect);

  let {
    $schema,
    cricket,
    ...rest
  } = schema;

  return Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [
      key,
      withoutSchemaDialect(value)
    ])
  );
}

function cricketJsonSchemaOptions() {
  return {
    io: 'input',
    unrepresentable: 'any',
    override({ zodSchema, jsonSchema }) {
      if (zodSchema?._zod?.def?.type !== 'date')
        return;

      jsonSchema.type = 'string';
      jsonSchema.format = 'date-time';
    }
  };
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
    return withoutSchemaDialect(z.toJSONSchema(schema, cricketJsonSchemaOptions()));

  return schema;
}
