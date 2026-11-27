import { defineCricketApp, defineEndpoint, z } from '@robdel12/cricket';

// The homepage demo. Dolbear's law turns cricket chirps per minute into degrees.
export let temperature = defineEndpoint({
  method: 'get',
  path: '/temperature',
  query: z.object({
    chirps: z.coerce.number().int().positive()
  }),
  response: z.object({ fahrenheit: z.number() }),
  handler({ input }) {
    return { fahrenheit: 50 + (input.query.chirps - 40) / 4 };
  }
});

export let app = defineCricketApp({
  name: 'Weather API',
  domains: [{ name: 'weather', endpoints: [temperature] }]
});
