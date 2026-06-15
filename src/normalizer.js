import {
  normalizerContractFailed,
  validationFailed
} from './errors.js';
import { parseZod } from './schema.js';

function parseSource(schema, value) {
  return parseZod(schema, value, validationFailed);
}

function parseOutput(schema, value) {
  return parseZod(schema, value, normalizerContractFailed);
}

/**
 * Define a source-boundary normalizer with source and output contracts.
 *
 * Normalizers stay pure. They receive source-shaped data, return app-shaped
 * plain data, and may return null/undefined to skip a source item.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {import('zod').ZodTypeAny} config.source
 * @param {import('zod').ZodTypeAny} config.output
 * @param {(value: any, context?: any) => any} config.normalize
 * @returns {Function & { normalizerName: string, source: import('zod').ZodTypeAny, output: import('zod').ZodTypeAny }}
 */
export function defineNormalizer({
  name,
  source,
  output,
  normalize
}) {
  if (!name) throw new Error('Normalizer name is required');
  if (!source) throw new Error(`Normalizer ${name} needs a source schema`);
  if (!output) throw new Error(`Normalizer ${name} needs an output schema`);
  if (typeof normalize !== 'function')
    throw new Error(`Normalizer ${name} needs a normalize function`);

  let normalizer = (value, context) => {
    let normalized = normalize(parseSource(source, value), context);

    if (normalized === null || normalized === undefined)
      return normalized;

    return parseOutput(output, normalized);
  };

  Object.defineProperties(normalizer, {
    normalizerName: { value: name },
    source: { value: source },
    output: { value: output }
  });

  return Object.freeze(normalizer);
}
