import {
  camelCaseKeys,
  defineSerializer,
  pickFields
} from '../../../../../src/index.js';
import { Build } from './build.model.js';

export let serializeBuildPublic = defineSerializer({
  name: 'build.public',
  output: Build.public,
  serialize: camelCaseKeys(
    pickFields([
      'id',
      'name',
      'public'
    ])
  )
});
