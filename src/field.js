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

export function fieldVisibility(schema) {
  return schema?.meta?.()?.cricket?.visibility;
}

export function isFieldSchema(schema) {
  return isZodSchema(schema) && visibilityValues.has(fieldVisibility(schema));
}
