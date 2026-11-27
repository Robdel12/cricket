# Cricket

Node APIs that explain themselves.

Cricket is a functional, domain-first framework for Node APIs. Every route declares what it takes and what it returns, every definition is frozen, and your whole app reads straight from the folders. You, your team, and your coding agents all know where to look.

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

For a structured app with local agent skills, run `pnpm exec cricket init .`
and see [Organize your app](docs/guide.md#organize-your-app).

## What you get

- **Self-documenting.** Contracts get checked on every request and become OpenAPI, `cricket inspect` output, and agent guidance.
- **Domain-first.** Each feature is one folder, and each file in it has one job.
- **Functional and immutable.** Plain functions, plain objects, frozen definitions.
- **Built for agents.** Predictable files your coding agent can actually follow.
- **The boring stuff, built in.** Its own HTTP runtime, plus logging, tracing, jobs, state machines, migrations, and a test harness.

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
