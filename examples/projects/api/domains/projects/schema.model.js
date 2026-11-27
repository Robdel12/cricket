import { defineModel, field, z } from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'projects',
  row: {
    id: field.public(z.uuid()),
    owner_id: field.private(z.string(), { sensitive: true }),
    slug: field.public(z.string()),
    name: field.public(z.string())
  }
});
