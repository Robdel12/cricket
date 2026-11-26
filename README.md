# Cricket

Tiny contracts for sturdy Node APIs.

Cricket is a small framework for building Node APIs. You give each route a contract for what comes in and what goes out, and Cricket checks both. Everything in between is plain JavaScript: objects in, objects out.

No ORM, no classes to extend, no magic wiring. Just plain functions you can read.

## Install

You'll need Node 24 or newer.

```sh
pnpm add github:Robdel12/cricket
```

## Your first route

```js
import { defineCricketApp, defineEndpoint, startCricketApp, z } from '@robdel12/cricket';

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
```

Run `node api.js`, then `curl localhost:3000/hello/Cricket`. Cricket checks the params before your handler runs and the response before it goes out.

## What you get

- **Contracts at the edges.** Zod checks params, query, body, and responses.
- **A predictable shape.** Each feature is a domain folder, and each file in it has one job.
- **Its own HTTP runtime.** Streaming, uploads, proxies, and clean shutdown, with no Express underneath.
- **The boring stuff, built in.** Logging, tracing, jobs, state machines, migrations, OpenAPI, and a test harness.
- **Agent-friendly.** `cricket init` writes guidance so coding agents follow the same conventions you do.

## Read the docs

The docs live at **[robdel12.github.io/cricket](https://robdel12.github.io/cricket/)**. They walk through everything, from your first route to background jobs. You can also read the [guides](docs/guide.md) and [JavaScript API](docs/api.md) right here on GitHub.

Want to see a real app? [`examples/projects`](examples/projects/) is a small, tested API in the shape Cricket recommends.

## Working on Cricket

```sh
pnpm install
pnpm test
pnpm docs:dev
```

The docs build from comments in the source. See [Working on the docs](docs/documentation.md) for how that works, and [the vision](vision.md) for why Cricket makes the choices it does.

## License

MIT
