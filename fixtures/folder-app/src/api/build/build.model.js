import {
  defineModel,
  field,
  z
} from '../../../../../src/index.js';

export let Build = defineModel({
  name: 'Build',
  table: 'build',
  row: {
    id: field.public(z.uuid()),
    user_id: field.private(z.uuid(), { sensitive: true }),
    name: field.public(z.string()),
    public: field.public(z.coerce.boolean())
  }
});
