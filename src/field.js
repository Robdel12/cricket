import { isZodSchema } from './schema.js';

let visibilityValues = new Set(['public', 'private']);

function withFieldMetadata(schema, visibility, options = {}) {
  if (!isZodSchema(schema))
    throw new Error(`Cricket ${visibility} field needs a Zod schema`);

  if (options.sensitive !== undefined && typeof options.sensitive !== 'boolean')
    throw new Error(`Cricket ${visibility} field needs sensitive true or false`);

  let metadata = schema.meta();

  return schema.meta({
    ...metadata,
    cricket: {
      ...metadata?.cricket,
      visibility,
      sensitive: options.sensitive ?? false
    }
  });
}

/**
 * Field helpers mark model row fields with visibility and sensitive handling.
 *
 * They return normal Zod schemas with Cricket metadata attached, so parsed
 * values stay plain and row contracts remain composable.
 */
export let field = Object.freeze({
  public(schema, options) {
    return withFieldMetadata(schema, 'public', options);
  },

  private(schema, options) {
    return withFieldMetadata(schema, 'private', options);
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
 * Extract whether a field schema is marked sensitive.
 *
 * @param {any} schema - Zod schema with optional Cricket sensitive metadata.
 * @returns {boolean|undefined} The sensitive setting.
 */
export function fieldSensitive(schema) {
  return schema?.meta?.()?.cricket?.sensitive;
}

/**
 * Extract the complete Cricket field metadata from a field schema.
 *
 * @param {any} schema - Zod schema with optional Cricket field metadata.
 * @returns {{visibility: string|undefined, sensitive: boolean|undefined}}
 */
export function fieldMetadata(schema) {
  return {
    visibility: fieldVisibility(schema),
    sensitive: fieldSensitive(schema)
  };
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
