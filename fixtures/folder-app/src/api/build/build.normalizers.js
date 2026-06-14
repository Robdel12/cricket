import {
  defineNormalizer,
  z
} from '../../../../../src/index.js';
import { BuildCreateInput } from './build.validations.js';

export let normalizeBuildImport = defineNormalizer({
  name: 'build.import',
  source: z.object({
    name: z.string()
  }).passthrough(),
  output: BuildCreateInput,
  normalize(row) {
    return {
      name: row.name
    };
  }
});
