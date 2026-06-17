# Cricket Agent Guidance

## Product Direction

Cricket is a tiny Node API framework for sturdy contracts.

The core pattern is intentionally simple: models define durable row visibility,
validations protect input shape, normalizers shape outside data entering the app,
serializers shape API data leaving the app, services do data work, rules handle
auth/existence/business guards, and routes stay thin. Keep that architecture
obvious in every change.

## Package Manager

- Use `pnpm`.
- Keep `pnpm-lock.yaml` as the lockfile.
- Do not reintroduce `package-lock.json` or npm/yarn lockfiles.

## Code Style

- Use modern ES modules in `.js` files.
- Prefer `let` over `const`.
- Prefer plain functions and explicit inputs/outputs over classes.
- Preserve Cricket's functional data style: plain objects in, plain objects out,
  no model instances, no hidden mutation, no ORM-ish object lifecycle.
- Cricket owns its HTTP runtime. Do not wrap another web framework or add
  transport-shaped escape hatches.
- Avoid `setTimeout`, polling waits, and timing-dependent behavior.

## Architecture

- `defineModel` owns durable row contracts, public/private visibility, and named
  views. It does not own request lifecycle contracts like create/update.
- `*.validations.js` owns reusable body, params, query, source, and service input
  schemas. Routes import those schemas explicitly through `body`, `params`,
  `query`, and `response`; Cricket must not auto-wire validations by name.
- Normalizers are pure source-boundary functions for third-party APIs, CSVs,
  webhooks, queue payloads, imports, and legacy data. They do not fetch, write,
  enqueue, authorize, or know about HTTP.
- Serializers are pure domain functions for outgoing API projections. Keep them
  near routes, not buried in model instances. Use `defineSerializer` when the
  output should be actively parsed.
- `defineEndpoint` owns request validation, rule execution, handler execution,
  response validation, and docs metadata.
- `defineRule` owns named guards such as auth, ownership, existence, billing,
  and business constraints.
- Services are first-class app code. Keep them boring, explicit, and HTTP-
  agnostic by default.
- First-class app folders mean scaffolded, documented, inspectable, and
  agent-readable. They do not mean Cricket secretly owns runtime behavior.
- Domain folders are the framework contract. Cricket auto-loads standard
  `*.model.js`, `*.validations.js`, `*.normalizers.js`, `*.serializers.js`,
  `*.service.js`, `*.rules.js`, and `*.routes.js` files when they exist. Do not
  bring back `*.domain.js` manifest files or make optional files mandatory.
- `api/middleware/` is for request middleware. `api/services/` is for shared
  app capabilities. `api/workers/` is for background entrypoints.
  `api/migrations/` is app-owned database change history. `api/dev/` is
  local-only support.
- If code affects product behavior, design it into a domain, app service,
  worker, middleware, or migration. Do not create generic junk drawers.
- Logging is framework-owned. Apps may configure or extend the logger, but the
  runtime should pass one Cricket logger shape through setup, services, rules,
  handlers, middleware, startup, shutdown, and errors.
- Runtime lifecycle state is framework-owned. Apps may read `lifecycle` from
  setup, services, middleware, context, handlers, and shutdown hooks, but
  product health, queues, workers, and deploy checks stay app-owned.
- HTTP runtime files live in `src/http/` and must stay Cricket-owned.
  Persistence helpers live in `src/persistence/`.
- The Knex helper is not an ORM. Keep table design, migrations, mapping, and
  product logic in the app.
- The CLI scaffolds the preferred domain shape. Keep it thin: structure,
  orientation, and commands.
- Treat LLM/agent readability as a first-class design concern: predictable
  filenames, predictable exports, small pure functions, explicit dependencies,
  and tests through the API boundary.

## Testing

Use `$testing-philosophy`.

- Test API behavior through HTTP, the boundary a user/client consumes.
- Use the real Cricket runtime and a real database boundary for HTTP tests.
- Do not mock Cricket's own code.
- Mock only external services, time, or randomness.
- Assert user-visible outcomes: status codes, response shape, validation
  errors, auth behavior, and persisted rows.
- Do not add arbitrary sleeps or polling waits.
- For local Cricket verification, prefer `pnpm test` or `pnpm run check`.

## Docs

When changing framework behavior, update `README.md` for user-facing usage and
`vision.md` for direction/tradeoffs. Keep docs candid about what Cricket owns
and what remains app responsibility.

Update examples when public contracts change. The examples are part of the API
surface here, and stale examples will mislead the next real-app pass.
