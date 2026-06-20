---
name: cricket
description: Work in a Cricket Node API app. Use when changing Cricket domains, routes, validations, normalizers, serializers, services, rules, app structure, CLI usage, OpenAPI docs, or when deciding where product behavior belongs in a Cricket project.
---

# Cricket Skill

Use this when changing a Cricket API app.

## Orientation

Start with `pnpm cricket inspect api/index.js`, then read `api/index.js` and the domain files for the feature you are changing.

## Principles

- Keep data plain: no model instances, hidden mutation, or ORM lifecycle.
- Put contracts at real boundaries: requests, responses, source payloads, jobs, and database rows.
- Compose small functions. Keep side effects in services, handlers, jobs, middleware, migrations, or external clients.
- Preserve predictable files. Agents should be able to guess where behavior lives.

## App Shape

- Cricket provides the architecture, HTTP runtime, job runtime, logger, trace, and read-only runtime lifecycle. The app defines product behavior, auth policy, data work, worker entrypoints, product health, and deployment.
- `api/middleware/` is for request middleware, not domain authorization.
- `api/services/` is for narrow app-wide capabilities not owned by one domain.
- `api/workers/` is for background worker entrypoints that start Cricket workers.
- `api/migrations/` is migration history for the app's Cricket database contract.
- `api/dev/` is for local-only development support. If code touches product behavior, move that behavior into a real service, worker, migration, or domain.

## Domain Files

- Put durable row contracts in `*.model.js`.
- Put request, source, and service input schemas in `*.validations.js`.
- Put pure source-boundary projections in `*.normalizers.js`.
- Put outgoing API projections in `*.serializers.js`.
- Put data and integration operations in `*.service.js`.
- Put auth, existence, ownership, and business checks in `*.rules.js`.
- Put endpoint contracts in `*.routes.js`.
- Put asynchronous job contracts in `*.jobs.js`.

The folder is the domain. Optional files stay optional, but standard filenames should stay predictable.

## Change Flow

1. Update the schema at the boundary that changed.
2. Put request/source input schemas in `*.validations.js` and import them explicitly.
3. Normalize third-party/source payloads in `*.normalizers.js`.
4. Shape API output in `*.serializers.js`.
5. Keep data and integration work in services.
6. Put auth, existence, and ownership checks in rules.
7. Put async contracts in `*.jobs.js` when behavior leaves the request path.
8. Keep endpoint handlers and job handlers focused on composition.
9. Generate OpenAPI and check the contract diff when HTTP contracts changed.

## Focused Skills

- Use `cricket-jobs` for background work, scheduling, retries, worker entrypoints, and the `cricket_jobs` ledger.
- Use `cricket-observability` for logging, tracing, lifecycle, request/job inspection, and `cricket trace`.
- Use `cricket-testing` for HTTP-boundary tests, worker-boundary job tests, test state, and Cricket's test CLI.

## Commands

```sh
pnpm cricket init app .
pnpm cricket init agents .
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate status api/index.js
pnpm cricket new domain project api/domains
pnpm test
```

After scaffolding a domain, make sure the app's `domains` value points at the domain root, add table migrations in `api/migrations/` when the domain persists data, and regenerate OpenAPI when HTTP contracts changed.
