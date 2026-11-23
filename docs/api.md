<!-- Generated from source JSDoc. Run pnpm --filter cricket-docs generate --write-markdown. -->
# JavaScript API

Pick the import path you want to use. Each page lists the exports for that path, with their signatures and links to the source for this version.

For examples you can build on, start with [Using Cricket](guide.md#your-first-route). To describe your own HTTP API, see [Generate OpenAPI](guide.md#generate-openapi).

## @robdel12/cricket

| Export | Use |
| --- | --- |
| `applyRules` | Run rules in order, threading returned facts into the next rule context. |
| `badRequest` | Create a 400 Bad Request framework error. |
| `camelCaseKeys` | Convert serialized object keys from snake_case or kebab-case to camelCase. |
| `collectEndpoints` | Collect endpoint contracts from plain domain modules. |
| `collectModels` | Collect model contracts from plain domain modules. |
| `composeSerializers` | Compose multiple serializers into one shallow merged projection. |
| `concurrency` | Concurrency policy builders for Cricket jobs. |
| `createCricketJobs` | Create a producer-side Cricket jobs capability. |
| `createCricketLogger` | Create Cricket's small structured logger. |
| `createCricketRuntime` | Create a Cricket runtime from an app contract. |
| `created` | Create a 201 response. |
| `createJobLedgerTable` | Create the Cricket jobs ledger table. |
| `createKnexRepository` | Builds a Knex-backed repository around a Cricket model contract. |
| `createMachine` | Create a native XState chart to pass to `defineMachine`. |
| `createServices` | Build a service registry from domain-owned service factories. |
| `cricketError` | Create the framework's standard error shape so Cricket can map it to HTTP. |
| `cronSchedule` | Describe cron-backed schedule metadata for a Cricket job. |
| `defineApiVersions` | Define one immutable API version family that endpoints can opt into. |
| `defineCricketApp` | Define the Cricket app contract that CLIs, docs generation, and runtimes all consume. This is intentionally plain data plus setup/context functions. |
| `defineCricketPlugin` | Define an immutable package contribution made from ordinary Cricket domains. |
| `defineEndpoint` | Define a request/response contract around a handler. |
| `defineJob` | Define a Cricket background job contract. |
| `defineMachine` | Define a domain machine backed by a native XState v6 chart. Services evaluate events and decide how to persist the result and deliver emitted facts. |
| `defineModel` | Define a model contract for a table row and its output views. |
| `defineNormalizer` | Define a source-boundary normalizer with source and output contracts. |
| `definePluginSchema` | Define the Zod contracts that an app's service adapters must follow. |
| `defineRule` | Define a named guard that can be run against an endpoint context. |
| `defineSerializer` | Define a serializer as a pure projection with an enforced output contract. |
| `deprecateEndpoint` | Mark an endpoint as deprecated without changing its request/response behavior. |
| `domainFileTypes` | File suffixes Cricket loads from a domain folder. |
| `field` | Field helpers mark model row fields with visibility and sensitive handling. |
| `fieldSensitive` | Extract whether a field schema is marked sensitive. |
| `forbidden` | Return a 403 error when the caller lacks access. |
| `generateOpenApi` | Generates an OpenAPI 3.1 document from Cricket endpoint and model contracts. |
| `jobFailure` | Define first-class failure handlers for a Cricket job. |
| `loadDomains` | Load Cricket domains from the standard folder structure. |
| `machineVersions` | Describe supported chart versions and how to migrate saved checkpoints. |
| `mapKeys` | Map output keys from a serializer while preserving the values. |
| `normalizeLogger` | Normalize app-provided logging into Cricket's small logger shape. |
| `normalizerContractFailed` | Normalize normalizer output schema failures into the framework error format. |
| `notFound` | Return a 404 error when the requested resource is missing. |
| `ok` | Create a 200 response. |
| `pickFields` | Pick a fixed list of fields from a value and return them as a plain object. |
| `planCronSchedule` | Plan due cron slots from a schedule cursor and a fixed clock. |
| `redirect` | Create an explicit redirect response. |
| `redisQueue` | Describe the Redis queue a job should use. |
| `renameFields` | Rename fields from an input object into a new plain object shape. |
| `resolveCricketApp` | Resolve a Cricket app contract into loaded domains, endpoints, and models. |
| `resolveLogger` | Resolve runtime logger input into Cricket's logger shape. |
| `respond` | Create an explicit Cricket HTTP response with any valid final status. |
| `responseContractFailed` | Normalize response schema failures into the framework error format. |
| `retry` | Retry policy builders for Cricket jobs. |
| `serializerContractFailed` | Normalize serializer output schema failures into the framework error format. |
| `startCricketApp` | Start a Cricket app as a standalone HTTP server. |
| `startCricketWorker` | Start a Cricket worker runtime for registered jobs. |
| `state` | Inspect-only state metadata builders for Cricket jobs. |
| `toHttpError` | Convert a framework error into Cricket's HTTP payload shape. |
| `tooManyRequests` | Create a 429 Too Many Requests framework error. |
| `unauthenticated` | Return a 401 error when the request needs a signed-in user. |
| `validationFailed` | Normalize schema validation failures into the framework error format. |
| `withCookies` | Append response cookies to an explicit Cricket response. |
| `withError` | Keep a handled error for onError without adding it to the response body. |
| `withHeaders` | Compose response headers over an explicit Cricket response. |
| `withResponseBody` | Replace the body while preserving an explicit response's transport metadata. This is used after endpoint response validation. |
| `withResponseCleanup` | Attach one cleanup callback to an explicit Cricket response. |
| `withResponseHeaders` | Replace every response header with an exact immutable header object. |
| `z` | Build Zod schemas for Cricket contracts. |

## @robdel12/cricket/app

| Export | Use |
| --- | --- |
| `defineCricketApp` | Define the Cricket app contract that CLIs, docs generation, and runtimes all consume. This is intentionally plain data plus setup/context functions. |
| `isMainModule` | Check whether an app module is being executed directly by Node. |
| `resolveCricketApp` | Resolve a Cricket app contract into loaded domains, endpoints, and models. |

## @robdel12/cricket/domain

| Export | Use |
| --- | --- |
| `collectEndpoints` | Collect endpoint contracts from plain domain modules. |
| `collectJobs` | Collect job contracts from plain domain modules. |
| `collectMachines` | Collect machine contracts by ID. Duplicate IDs across domains throw. |
| `collectModels` | Collect model contracts from plain domain modules. |
| `createServices` | Build a service registry from domain-owned service factories. |
| `domainFileTypes` | File suffixes Cricket loads from a domain folder. |
| `loadDomains` | Load Cricket domains from the standard folder structure. |

## @robdel12/cricket/jobs

| Export | Use |
| --- | --- |
| `concurrency` | Concurrency policy builders for Cricket jobs. |
| `createCricketJobs` | Create a producer-side Cricket jobs capability. |
| `createJobLedgerTable` | Create the Cricket jobs ledger table. |
| `createTestQueueDriver` | Create an in-memory queue driver for Cricket job tests. |
| `cronSchedule` | Describe cron-backed schedule metadata for a Cricket job. |
| `defineJob` | Define a Cricket background job contract. |
| `jobFailure` | Define first-class failure handlers for a Cricket job. |
| `planCronSchedule` | Plan due cron slots from a schedule cursor and a fixed clock. |
| `planJobEnvelope` | Build the immutable envelope Cricket stores and queues for a job run. |
| `redisQueue` | Describe the Redis queue a job should use. |
| `retry` | Retry policy builders for Cricket jobs. |
| `startCricketWorker` | Start a Cricket worker runtime for registered jobs. |
| `state` | Inspect-only state metadata builders for Cricket jobs. |

## @robdel12/cricket/knex

| Export | Use |
| --- | --- |
| `createKnexRepository` | Builds a Knex-backed repository around a Cricket model contract. |

## @robdel12/cricket/logger

| Export | Use |
| --- | --- |
| `createCricketLogger` | Create Cricket's small structured logger. |
| `logEnvelope` | Build a structured log entry and redact sensitive metadata fields. |
| `normalizeLogger` | Normalize app-provided logging into Cricket's small logger shape. |
| `resolveLogger` | Resolve runtime logger input into Cricket's logger shape. |

## @robdel12/cricket/openapi

| Export | Use |
| --- | --- |
| `generateOpenApi` | Generates an OpenAPI 3.1 document from Cricket endpoint and model contracts. |

## @robdel12/cricket/serializer

| Export | Use |
| --- | --- |
| `camelCaseKeys` | Convert serialized object keys from snake_case or kebab-case to camelCase. |
| `composeSerializers` | Compose multiple serializers into one shallow merged projection. |
| `defineSerializer` | Define a serializer as a pure projection with an enforced output contract. |
| `mapKeys` | Map output keys from a serializer while preserving the values. |
| `pickFields` | Pick a fixed list of fields from a value and return them as a plain object. |
| `renameFields` | Rename fields from an input object into a new plain object shape. |

## @robdel12/cricket/sentry

| Export | Use |
| --- | --- |
| `sentryErrorHandler` | Adapt Cricket's onError hook to an app-owned, initialized Sentry SDK. |

## @robdel12/cricket/oidc-provider

| Export | Use |
| --- | --- |
| `createOidcProviderHost` | Create a Cricket-owned OIDC provider host. Provider/Koa/Node objects stay inside the integration; apps provide only protocol policy and plain facts. |

## @robdel12/cricket/test

| Export | Use |
| --- | --- |
| `createTestClient` | Create a real HTTP client for a Cricket runtime. |
| `createTestRuntime` | Create a Cricket runtime wired for test inspection. |
| `createTestState` | Create an in-memory Cricket test collector. |
