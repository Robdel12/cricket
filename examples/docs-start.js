import {
  defineCricketApp,
  defineEndpoint,
  startCricketApp,
  z
} from '@robdel12/cricket';

let hello = defineEndpoint({
  method: 'get',
  path: '/hello/:name',
  params: z.object({ name: z.string().min(1) }),
  response: z.object({ message: z.string() }),
  handler({ input }) {
    return { message: `Hey, ${input.params.name}!` };
  }
});

export let app = defineCricketApp({
  name: 'Hello API',
  domains: [{ name: 'hello', endpoints: [hello] }]
});

await startCricketApp(app, { port: 3000, main: import.meta.url });
