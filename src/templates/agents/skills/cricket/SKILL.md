---
name: cricket
description: Build or change a Cricket API domain, endpoint, or app. Use for domain files, request and response contracts, app wiring, and OpenAPI.
---

# Cricket

Read the app entry and nearby domain files. Use `pnpm exec cricket check api/index.js`
to check structure and `pnpm exec cricket inspect api/index.js` to see what the
app loads. Use the actual entry path for the project.

## Change a domain

- Put product contracts in domains. Reserve `architecture: 'manual'` for
  migrating an existing app.
- Scaffold only the files you need. For a basic endpoint, run
  `pnpm exec cricket new domain projects api/domains --with validations,service,routes,test`.
  Replace the test todo with a real behavior test.
- Give `defineEndpoint` explicit `params`, `query`, `headers`, and `body`
  schemas where needed. The handler reads parsed values from `input`. Use
  named rules for access and other checks. Export a factory such as
  `createProjectsService({ db })` from the domain service file. Call its
  methods through `services.projects`.
- Use a model for the stored row. Use a pure normalizer for outside data and a
  serializer or explicit public schema for output. Put request schemas in
  `*.validations.js`.
- A bare return is the response body. Use `created`, `respond`, or `redirect`
  to set status and `withHeaders` to add headers. Declare the public response
  schema. Keep internal schema errors out of client responses.
- Check changed contracts through HTTP. Regenerate OpenAPI with
  `pnpm exec cricket docs api/index.js --out openapi.json`.

## App wiring

Export the app from its entry module. Pass `main: import.meta.url` to
`startCricketApp` so the CLI can import the app without starting the listener.
Set app `baseUrl: import.meta.url` so tests and workers find relative domain
paths. Build shared dependencies in setup and clean them up there. Put
database changes in app migrations. The app owns auth, queries, health, and
deployment.

Use `defineCricketPlugin` to share named domains and `definePluginSchema` to
check the host's service methods and their inputs and outputs. The host app
owns authorization and storage.

## More detail

- Read [HTTP contracts](references/http.md) for Fetch, uploads, API versions,
  OpenAPI metadata, streams, proxies, and protocol hosts.
- Use [cricket-jobs](../cricket-jobs/SKILL.md) for background work,
  [cricket-machines](../cricket-machines/SKILL.md) for product events,
  [cricket-observability](../cricket-observability/SKILL.md) for runtime behavior,
  and [cricket-testing](../cricket-testing/SKILL.md) for tests.
- See the [Cricket docs](https://robdel12.github.io/cricket/) for examples and
  the API reference. Check the installed Cricket source for signatures when
  the app runs a different version.
