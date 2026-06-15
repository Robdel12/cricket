import { validationFailed } from './errors.js';
import { fieldMetadata, fieldSensitive, fieldVisibility, isFieldSchema } from './field.js';
import { parseZod } from './schema.js';
import { z } from 'zod';

function parseModelSchema(schema, value) {
  return parseZod(schema, value, validationFailed);
}

let reservedModelKeys = new Set([
  'name',
  'table',
  'fields',
  'row',
  'public',
  'views',
  'viewNames',
  'fieldMetadata',
  'publicFields',
  'privateFields',
  'parseRow',
  'parsePublic',
  'parseView'
]);

function toPascalCase(value) {
  return String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('');
}

function parseHelperName(viewName) {
  return `parse${toPascalCase(viewName)}`;
}

function schemaFromFields(fields, fieldNames) {
  return z.object(Object.fromEntries(
    fieldNames.map(fieldName => [fieldName, fields[fieldName]])
  )).strict();
}

function metadataFromFields(fields, fieldNames) {
  return Object.freeze(Object.fromEntries(
    fieldNames.map(fieldName => [
      fieldName,
      Object.freeze(fieldMetadata(fields[fieldName]))
    ])
  ));
}

function assertFieldMap(name, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error(`Model ${name} needs a row field map`);

  for (let [fieldName, schema] of Object.entries(fields)) {
    if (!isFieldSchema(schema))
      throw new Error(`Model ${name} field ${fieldName} needs field.public(...) or field.private(...)`);

    if (fieldSensitive(schema) === undefined)
      throw new Error(`Model ${name} field ${fieldName} needs sensitive true or false`);
  }
}

function viewFieldsFor(name, fields, viewName, fieldNames) {
  if (!Array.isArray(fieldNames))
    throw new Error(`Model ${name} view ${viewName} needs a field list`);

  for (let fieldName of fieldNames) {
    if (!fields[fieldName])
      throw new Error(`Model ${name} view ${viewName} includes unknown field ${fieldName}`);
  }

  return fieldNames;
}

function assertParseHelperName(name, viewNames, helperNames, viewName) {
  let helperName = parseHelperName(viewName);

  if (reservedModelKeys.has(helperName) || viewNames.has(helperName))
    throw new Error(`Model ${name} view ${viewName} creates conflicting helper ${helperName}`);

  if (helperNames.has(helperName))
    throw new Error(`Model ${name} view ${viewName} creates duplicate helper ${helperName}`);

  helperNames.add(helperName);
  return helperName;
}

/**
 * Define a model contract for a table row and its output views.
 *
 * The model stays framework-agnostic: it owns durable row parsing plus
 * public/private visibility and sensitive-field metadata, while persistence and
 * serialization stay with the caller.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.table
 * @param {Record<string, import('zod').ZodTypeAny>} config.row
 * @param {Record<string, string[]>} [config.views]
 * @returns {{
 *   name: string,
 *   table: string,
 *   fields: Record<string, import('zod').ZodTypeAny>,
 *   row: import('zod').ZodTypeAny,
 *   public: import('zod').ZodTypeAny,
 *   views: Record<string, import('zod').ZodTypeAny>,
 *   fieldMetadata: Record<string, { visibility: string, sensitive: boolean }>,
 *   parseRow(value: any): any,
 *   parsePublic(value: any): any,
 *   parseView(name: string, value: any): any
 * }}
 */
export function defineModel({
  name,
  table,
  row,
  views = {}
}) {
  if (!name) throw new Error('Model name is required');
  if (!table) throw new Error(`Model ${name} needs a table`);
  assertFieldMap(name, row);

  let fields = Object.freeze({ ...row });
  let fieldNames = Object.freeze(Object.keys(fields));
  let publicFields = fieldNames.filter(fieldName =>
    fieldVisibility(fields[fieldName]) === 'public'
  );
  let privateFields = fieldNames.filter(fieldName =>
    fieldVisibility(fields[fieldName]) === 'private'
  );
  let rowSchema = schemaFromFields(fields, fieldNames);
  let publicSchema = schemaFromFields(fields, publicFields);
  let modelFieldMetadata = metadataFromFields(fields, fieldNames);
  let viewSchemas = {};
  let viewNames = new Set(Object.keys(views));
  let viewHelperNames = new Map();
  let helperNames = new Set();

  for (let [viewName, viewFieldNames] of Object.entries(views)) {
    if (reservedModelKeys.has(viewName))
      throw new Error(`Model ${name} view ${viewName} conflicts with a model property`);

    viewHelperNames.set(
      viewName,
      assertParseHelperName(name, viewNames, helperNames, viewName)
    );
    viewSchemas[viewName] = schemaFromFields(
      fields,
      viewFieldsFor(name, fields, viewName, viewFieldNames)
    );
  }

  publicFields = Object.freeze(publicFields);
  privateFields = Object.freeze(privateFields);
  viewSchemas = Object.freeze(viewSchemas);

  let model = {
    name,
    table,
    fields,
    row: rowSchema,
    public: publicSchema,
    views: viewSchemas,
    viewNames: Object.keys(viewSchemas),
    fieldMetadata: modelFieldMetadata,
    publicFields,
    privateFields,

    ...viewSchemas,

    parseRow(value) {
      return parseModelSchema(rowSchema, value);
    },

    parsePublic(value) {
      return parseModelSchema(publicSchema, value);
    },

    parseView(viewName, value) {
      if (!viewSchemas[viewName])
        throw new Error(`Model ${name} does not define view ${viewName}`);

      return parseModelSchema(viewSchemas[viewName], value);
    }
  };

  for (let [viewName, helperName] of viewHelperNames) {
    model[helperName] = value => {
      return parseModelSchema(viewSchemas[viewName], value);
    };
  }

  return Object.freeze(model);
}
