import { z } from 'zod';

import { defineModel } from '../../../../../src/index.js';

export let BuildInsert = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  name: z.string().min(1),
  public: z.boolean().default(false)
});

export let Build = defineModel({
  name: 'Build',
  table: 'build',
  row: z.object({
    id: z.uuid(),
    user_id: z.uuid(),
    name: z.string(),
    public: z.coerce.boolean()
  }),
  create: z.object({
    name: z.string().min(1)
  })
});
