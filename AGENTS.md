# Cricket Agent Guidance

## Product Direction

Cricket is a tiny Node API framework for sturdy contracts in Koa + Knex apps.

The core pattern is intentionally simple: services do data work, rules handle
auth/existence/business guards, schemas protect boundaries, serializers shape
outgoing API data, and routes stay thin. Keep that architecture obvious in every
change.

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
- Keep adapters at the edges. Core endpoint/model/rule contracts should not
  depend on Koa, Knex, or any specific app framework.
- Avoid `setTimeout`, polling waits, and timing-dependent behavior.

## Architecture

- `defineModel` owns durable row/create/update schema contracts.
- Serializers are pure domain functions for outgoing API projections. Keep them
  near routes, not buried in model instances.
- `defineEndpoint` owns request validation, auth enforcement, rules, handler
  execution, response validation, and docs metadata.
- `defineRule` owns named guards such as auth, ownership, existence, billing,
  and business constraints.
- Services are first-class app code. Keep them boring, explicit, and HTTP-
  agnostic by default.
- Domain folders are the framework contract. Cricket auto-loads standard
  `*.model.js`, `*.serializers.js`, `*.service.js`, `*.rules.js`, and
  `*.routes.js` files from the configured domain root. Do not bring back
  `*.domain.js` manifest files.
- Logging is framework-owned. Apps may configure or extend the logger, but the
  runtime should pass one Cricket logger shape through setup, services, rules,
  handlers, adapters, startup, and errors.
- Koa and Knex are first-class adapters, but the design should remain pluggable
  for other HTTP/database tools.
- Keep adapter files grouped by Cricket role: HTTP in `src/http/`, persistence
  in `src/persistence/`. Give an adapter its own folder only once it has real
  internal files to hold.
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
- Use real Koa middleware and a real database boundary when testing adapters.
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
