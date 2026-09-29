import {
  defineModel,
  field,
  z
} from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: {
    id: field.public(z.string()),
    name: field.public(z.string())
  }
});
