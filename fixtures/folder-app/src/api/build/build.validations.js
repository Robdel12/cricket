import { z } from '../../../../../src/index.js';

export let BuildCreateInput = z.object({
  name: z.string().min(1)
});

export let BuildInsert = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  name: z.string().min(1),
  public: z.boolean().default(false)
});

export let BuildParams = z.object({
  buildId: z.uuid()
});
