import { z } from '@robdel12/cricket';

export let ProjectParams = z.object({
  slug: z.string().min(3)
});

export let CreateProjectBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  name: z.string().min(1).max(100)
});
