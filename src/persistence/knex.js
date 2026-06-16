import { validationFailed } from '../errors.js';
import {
  isZodSchema,
  parseZod
} from '../schema.js';

function parseWith(schema, value) {
  if (!schema) return value;
  if (!isZodSchema(schema)) return value;

  return parseZod(schema, value, validationFailed);
}

function parsedRow(model, row) {
  return row ? model.parseRow(row) : undefined;
}

function returnedRow(result) {
  return Array.isArray(result) ? result[0] : result;
}

function spanMetadata(table, metadata = {}) {
  return {
    table,
    ...metadata
  };
}

function runSpan(trace, name, metadata, handler) {
  if (typeof trace?.span !== 'function')
    return handler();

  return trace.span(name, metadata, handler);
}

async function firstParsedRow(model, query) {
  let row = await query.first();
  return parsedRow(model, row);
}

async function parseReturnedRow(model, query, returning) {
  if (returning === false) {
    await query;
    return undefined;
  }

  let result = await query.returning(returning);
  let row = returnedRow(result);
  return row ? model.parseRow(row) : undefined;
}

/**
 * Builds a Knex-backed repository around a Cricket model contract.
 *
 * The repository keeps persistence concerns at the edge while returning plain
 * parsed domain objects from all read/write methods.
 *
 * @param {object} options
 * @param {Function} options.db - Knex instance or query builder factory.
 * @param {object} options.model - Cricket model contract used to parse rows.
 * @param {string} [options.table=model?.table] - Table name to query.
 * @param {string} [options.idColumn='id'] - Primary key column used by lookup helpers.
 * @param {string|Array<string>|false} [options.returning='*'] - Knex `returning()` value, or `false` when the dialect does not support it.
 * @param {object} [options.insert] - Optional schema used to validate insert values before persistence.
 * @param {object} [options.update] - Optional schema used to validate update values before persistence.
 * @param {object} [options.trace] - Optional trace object with `span(name, metadata, fn)` for repository timing.
 * @returns {object} Repository with `query`, `findById`, `findOne`, `list`, `insert`, `updateById`, and `deleteById`.
 */
export function createKnexRepository({
  db,
  model,
  table = model?.table,
  idColumn = 'id',
  returning = '*',
  insert,
  update,
  trace
}) {
  if (!db) throw new Error('Knex repository needs a db');
  if (!model) throw new Error('Knex repository needs a model');
  if (!table) throw new Error(`Knex repository for ${model.name} needs a table`);

  function query() {
    return db(table);
  }

  async function findByIdRaw(id) {
    return await firstParsedRow(
      model,
      query().where(idColumn, id)
    );
  }

  async function findById(id) {
    return await runSpan(trace, 'knex.findById', spanMetadata(table, {
      idColumn
    }), async () => {
      return await findByIdRaw(id);
    });
  }

  return {
    table,
    idColumn,

    query,

    findById,

    async findOne(where) {
      return await runSpan(trace, 'knex.findOne', spanMetadata(table, {
        criteriaCount: Object.keys(where ?? {}).length
      }), async () => {
        return await firstParsedRow(
          model,
          db(table).where(where)
        );
      });
    },

    async list(where = {}) {
      return await runSpan(trace, 'knex.list', spanMetadata(table, {
        criteriaCount: Object.keys(where ?? {}).length
      }), async () => {
        let rows = await db(table).where(where);
        return rows.map(row => model.parseRow(row));
      });
    },

    async insert(values) {
      return await runSpan(trace, 'knex.insert', spanMetadata(table, {
        returning: returning !== false
      }), async () => {
        let parsed = parseWith(insert, values);
        let row = await parseReturnedRow(
          model,
          db(table).insert(parsed),
          returning
        );

        if (row || returning !== false)
          return row;

        return await findByIdRaw(parsed[idColumn]);
      });
    },

    async updateById(id, values) {
      return await runSpan(trace, 'knex.updateById', spanMetadata(table, {
        returning: returning !== false
      }), async () => {
        let row = await parseReturnedRow(
          model,
          db(table)
            .where(idColumn, id)
            .update(parseWith(update, values)),
          returning
        );

        if (row || returning !== false)
          return row;

        return await findByIdRaw(id);
      });
    },

    async deleteById(id) {
      return await runSpan(trace, 'knex.deleteById', spanMetadata(table, {
        idColumn
      }), async () => {
        return await db(table)
          .where(idColumn, id)
          .delete();
      });
    }
  };
}
