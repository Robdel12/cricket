import { z } from 'zod';

import {
  camelCaseKeys,
  pickFields
} from '../../../../../src/index.js';

export let BuildPublic = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  public: z.boolean()
});

export let serializeBuildPublic = camelCaseKeys(
  pickFields([
    'id',
    'user_id',
    'name',
    'public'
  ])
);
