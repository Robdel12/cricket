import { isZodSchema } from './schema.js';

let visibilityValues = new Set(['public', 'private']);

function withVisibility(schema, visibility) {
  if (!isZodSchema(schema))
    throw new Error(`Cricket ${visibility} field needs a Zod schema`);

  let metadata = schema.meta();

  return schema.meta({
    ...metadata,
    cricket: {
      ...metadata?.cricket,
      visibility
    }
  });
}

/**
 * Field helpers mark model row fields as safe or unsafe for public output.
 *
 * They return normal Zod schemas with Cricket metadata attached, so parsed
 * values stay plain and row contracts remain composable.
 */
export let field = Object.freeze({
  public(schema) {
    return withVisibility(schema, 'public');
  },

  private(schema) {
    return withVisibility(schema, 'private');
  }
});

/**
 * Extract the visibility marking from a field schema.
 *
 * @param {any} schema - Zod schema with optional Cricket visibility metadata.
 * @returns {'public'|'private'|undefined} The visibility setting.
 */
export function fieldVisibility(schema) {
  return schema?.meta?.()?.cricket?.visibility;
}

/**
 * Check whether a schema is a Cricket field schema with visibility metadata.
 *
 * @param {any} schema - Schema to check.
 * @returns {boolean} True when the schema has public or private visibility.
 */
export function isFieldSchema(schema) {
  return isZodSchema(schema) && visibilityValues.has(fieldVisibility(schema));
}
