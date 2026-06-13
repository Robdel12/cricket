import { validationFailed } from './errors.js';
import { parseZod } from './schema.js';

function parseModelSchema(schema, value) {
  return parseZod(schema, value, validationFailed);
}

/**
 * Define a model contract for a table row plus its create/update payloads.
 *
 * The model stays framework-agnostic: it only owns schema parsing and named
 * metadata, while persistence stays with the caller.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.table
 * @param {import('zod').ZodTypeAny} config.row
 * @param {import('zod').ZodTypeAny} [config.create]
 * @param {import('zod').ZodTypeAny} [config.update]
 * @returns {{
 *   name: string,
 *   table: string,
 *   row: import('zod').ZodTypeAny,
 *   create?: import('zod').ZodTypeAny,
 *   update?: import('zod').ZodTypeAny,
 *   parseRow(value: any): any,
 *   parseCreate(value: any): any,
 *   parseUpdate(value: any): any
 * }}
 */
export function defineModel({
  name,
  table,
  row,
  create,
  update
}) {
  if (!name) throw new Error('Model name is required');
  if (!table) throw new Error(`Model ${name} needs a table`);
  if (!row) throw new Error(`Model ${name} needs a row schema`);

  return {
    name,
    table,
    row,
    create,
    update,

    parseRow(value) {
      return parseModelSchema(row, value);
    },

    parseCreate(value) {
      return parseModelSchema(create, value);
    },

    parseUpdate(value) {
      return parseModelSchema(update, value);
    }
  };
}
