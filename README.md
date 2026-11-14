# Cricket

Tiny contracts for sturdy Node APIs.

Cricket gives Node APIs the backend shape that stays pleasant as the app grows:
plain JavaScript, Zod contracts, predictable domain files, thin routes, boring
services, first-class jobs, OpenAPI generation, and a normal Node entrypoint.

No model instances. No hidden mutation. No ORM lifecycle. Your app passes plain
objects around, composes functions, and keeps side effects at the edges.

## Install

```sh
pnpm add @robdel12/cricket
```

## Adopt Cricket

Start with the complete structured app and agent contract:

```sh
pnpm cricket init .
pnpm cricket check api/index.js
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
```

`init` creates the folders Cricket expects, adds the Cricket section to
`AGENTS.md`, and installs a small local skill suite under `.agents/skills/`:

- `cricket` teaches the framework shape, domain pattern, and change flow.
- `cricket-jobs` teaches jobs, schedules, retries, workers, and the ledger.
- `cricket-observability` teaches logging, tracing, lifecycle, and debugging.
- `cricket-testing` teaches HTTP-boundary tests, worker-boundary job tests, and
  Cricket test state.

That skill suite is part of Cricket's docs surface. It exists because Cricket is
meant to be easy for agents to use correctly while humans drive the product
decisions.

`init app` and `init agents` remain available as focused commands for existing
projects, but `init .` is the normal adoption path.

In this repo, the canonical scaffolded guidance lives in
`src/templates/agents/`, including each skill's real `SKILL.md` file.

## Principles

- Keep data plain: objects in, objects out.
- Keep side effects at clear boundaries: services, handlers, jobs, middleware,
  migrations, and external clients.
- Keep contracts at real edges: requests, responses, source payloads, jobs, and
  database rows.
- Keep definitions stable: app, endpoint, rule, model, serializer, normalizer,
  and job contracts cannot drift after construction. Cricket owns immutable
  contract structure without freezing caller-owned runtime values.
- Keep domain files predictable. Agents should be able to guess where behavior
  lives before they open the repo.
- Keep framework behavior visible. Cricket provides runtime shape; your app
  defines product behavior, auth policy, data policy, worker entrypoints,
  health checks, and deployment.

## App Shape

```text
api/
  index.js      app entrypoint and Cricket wiring
  domains/      product API domains
  middleware/   request middleware
  services/     app-wide capabilities
  workers/      background worker entrypoints
  migrations/   app database migrations
  dev/          local-only support
```

Use `domains/` for product behavior. Use `middleware/` for HTTP edge work such
as auth extraction, CORS, request IDs, raw webhooks, and frontend fallbacks. Use
`services/` for narrow shared capabilities like mail, storage, payments, caches,
and external clients. Use `workers/` for background entrypoints that start
Cricket workers. Use `dev/` only for local support.

If code affects product behavior, put it in a domain, app service, worker,
middleware, or migration. Avoid generic junk drawers.

### Manual architecture is migration debt

Cricket requires a `domains` contract by default. Structured apps cannot
register `endpoints`, `jobs`, or `models` directly on `defineCricketApp`; those
contracts must come from domains.

Existing or embedded applications can temporarily opt out:

```js
export let app = defineCricketApp({
  architecture: 'manual',
  endpoints: legacyEndpoints
});
```

Manual architecture is an escape hatch, not a second recommended application
shape. Treat it as visible tech debt while migrating an existing app. Cricket
labels it in `inspect` and `check`; remove it once product contracts live in
domains. Manual mode cannot be mixed with `domains`, so the final cutover is
deliberate and direct rather than a permanent hybrid architecture.

## Domain Shape

Use one folder per domain.

```text
api/domains/project/
  schema.model.js         row contracts and visibility
  input.validations.js    request/source/service input schemas
  source.normalizers.js   outside payload projections
  output.serializers.js   API output projections
  domain.service.js       data and product operations
  access.rules.js         auth, existence, ownership, business guards
  http.routes.js          endpoint contracts
  *.jobs.js               background job contracts
  behavior.test.js        HTTP and worker-boundary tests
```

The folder is the domain. Cricket auto-loads direct domain-local files by
suffix, such as `*.model.js`, `*.routes.js`, and `*.jobs.js`. Optional files
stay optional, and filenames can describe the slice they contain.

## App Entry

Put the app contract in `api/index.js`.

```js
import { defineCricketApp, startCricketApp } from '@robdel12/cricket';

export let app = defineCricketApp({
  name: 'Project API',
  version: '1.0.0',
  prefix: '/api',
  logger: {
    service: 'project-api',
    level: process.env.LOG_LEVEL ?? 'info'
  },
  database: {
    client: 'pg',
    defaultEnvironment: 'development',
    environments: {
      development: {
        connection: process.env.DATABASE_URL
      },
      test: {
        client: 'sqlite3',
        connection: {
          filename: ':memory:'
        },
        useNullAsDefault: true
      },
      production: {
        connection: process.env.DATABASE_URL
      }
    }
  },
  domains: './domains',
  async setup({ db }) {
    return {
      services: {
        projects: createProjectService({ db })
      }
    };
  }
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, {
    port: process.env.PORT || 3000,
    main: import.meta.url
  });
```

`setup` returns `undefined` or one explicit object with `dependencies`,
`services`, `protocolHosts`, and `cleanup`. Cricket adds its configured `db` to dependencies;
apps must not return a second `db`. Setup runs when the runtime is created, not
when CLI commands import the app definition. Cleanup runs after accepted HTTP
work drains and before Cricket destroys its configured database connection.

Capabilities follow the runtime phase that owns them. Setup receives the app,
database, lifecycle, logger, and a no-op startup trace. Domain services, the
app service composer, and middleware initialization receive dependencies,
lifecycle, and logger before requests exist. Request context, rules, and
handlers receive the request logger and trace plus services, lifecycle, and
setup dependencies. Job `run` and failure handlers receive services, lifecycle,
logger, trace, jobs, and progress. Recovery receives execution evidence, time,
logger, and trace because it returns a pure decision rather than doing product
work. Shutdown hooks receive the assembled runtime, including dependencies,
services, lifecycle, and logger.


## Configure trusted proxies

Cricket ignores forwarding headers by default. If a reverse proxy terminates TLS,
configure its verified socket addresses on the app:

```js
let app = defineCricketApp({
  domains: './domains',
  trustProxy: { peers: ['127.0.0.1', '::1'] },
  allowedHosts: ['api.example.test']
});
```

These loopback peers are an example for a proxy on the same machine. Use your
actual deployment peers or CIDRs, restrict network access, and have the proxy
overwrite `X-Forwarded-Host` and `X-Forwarded-Proto`. A private network range is
not evidence that every caller on it is a trusted proxy. `trustProxy: true`, hop
counts, hostnames, empty peer lists, and malformed IP/CIDR entries are rejected.
Use `false` or omit the option for direct traffic.

The plain request exposes `peerIp` (the native socket peer), `clientIp`, and
`proxyTrusted` (whether that immediate peer is allowed). IPv4-mapped IPv6 becomes
IPv4; other IPv6 addresses use compressed form. Unknown or scoped socket
addresses produce null IP facts and cannot establish trust. Automatic request
logs and test snapshots omit the peer/client IP fields.

For an allowed peer, Cricket validates every comma-separated `X-Forwarded-For`
hop, combining repeated physical headers in wire order. It walks from the socket
peer right to left and stops at the first untrusted hop. Anything farther left
cannot choose the client IP. Missing XFF leaves `clientIp` equal to `peerIp`.
Invalid or empty hops return 400. `Forwarded` and `X-Real-IP` are ignored.

Only allowed peers can supply `X-Forwarded-Host` and `X-Forwarded-Proto`. Each must
be a single header value; repeated headers, comma lists, invalid authorities, and
protocols other than HTTP/HTTPS return 400. Missing values fall back to the
validated direct Host and socket TLS state. Untrusted peers' forwarding headers
are ignored, including malformed values. `allowedHosts` still checks the
resulting host.

OIDC uses these same validated host, protocol, and IP facts, including HTTPS
redirects and Secure cookies behind a trusted HTTP proxy. Configure trust only
on the app; the OIDC host has no separate proxy setting. Its plain hook request
keeps `ip` equal to `clientIp` and also includes `peerIp`, `proxyTrusted`,
`protocol`, and `secure`. The existing hook `origin` remains the browser's Origin
header for consent checks.

## Host OIDC inside Cricket

When an app needs OAuth or OpenID Connect, it can keep the protocol engine inside
Cricket and keep account, consent, and persistence policy inside its own domains.
Install the optional provider packages with `pnpm add oidc-provider koa koa-mount`
and import the first-party integration from `@robdel12/cricket/oidc-provider`.

`createOidcProviderHost()` creates the provider and its private Koa mount. It
returns a Cricket-owned HTTP descriptor, a narrow authorization capability for
domain services, and a `bind()` method for the app's policy hooks. Return the
descriptor from setup; bind hooks from the app service composer, after domain
services exist and before the runtime accepts requests:

```js
import { createOidcProviderHost } from '@robdel12/cricket/oidc-provider';

async setup({ db }) {
  let oidc = await createOidcProviderHost({
    origin: process.env.PUBLIC_ORIGIN,
    issuer: `${process.env.PUBLIC_ORIGIN}/oauth`,
    resource: `${process.env.PUBLIC_ORIGIN}/mcp`,
    csrfKey: process.env.OAUTH_CSRF_KEY,
    adapter: createOAuthAdapter({ db }),
    clients: readOAuthClients(),
    jwks: readOAuthJwks(),
    cookieKeys: readOAuthCookieKeys(),
    cookieNames: {
      session: 'app_oauth_session',
      interaction: 'app_oauth_interaction',
      resume: 'app_oauth_resume'
    },
    paths: {
      providerMount: '/oauth',
      resourceMetadata: '/.well-known/oauth-protected-resource/mcp',
      authorizationMetadata: '/.well-known/oauth-authorization-server/oauth',
      interaction: '/api/oauth-interactions',
      interactionLanding: '/mcp/authorize'
    },
    resourceScopes: ['read'],
    scopesSupported: ['read'],
    bearerMethodsSupported: ['header'],
    browserCredentialCookie: 'access_token',
    fetch: fetchOAuthMetadata
  });

  return {
    protocolHosts: [oidc.protocolHost],
    dependencies: { oidc }
  };
},
services({ dependencies, services }) {
  dependencies.oidc.bind({
    authorizeRequest: facts => services.oauth.authorizeRequest(facts),
    authorizeRevocation: facts => services.oauth.authorizeRevocation(facts),
    withRequest: (facts, run) => services.oauth.withProtocolRequest(facts, run),
    resolveAccount: facts => services.oauth.resolveAccount(facts),
    deleteGrantArtifacts: facts => services.oauth.deleteGrantArtifacts(facts),
    prepareInteraction: facts => services.oauth.prepareInteraction(facts),
    consentDetails: facts => services.oauth.consentDetails(facts),
    decideConsent: facts => services.oauth.decideConsent(facts),
    allowClientMetadata: facts => services.oauth.allowClientMetadata(facts),
    allowClient: facts => services.oauth.allowClient(facts)
  });
  return services;
}
```

The hook inputs and outputs are validated plain JSON facts. The one
`withRequest(facts, run)` hook is the app's transaction boundary: it must await
`run()` so Provider reads, consent writes, and revocation cleanup stay inside
that transaction. Hooks never receive Provider instances, Koa contexts, Node
requests, or Node responses. `authorizeRequest` can reject or rate-limit a route
before Provider work; `authorizeRevocation` decides whether the authenticated
client may revoke a token. Consent hooks own browser-session checks, origin and
CSRF checks, current account policy, and durable app grants. `resolveAccount`
rechecks account and grant state for token use. Remote metadata fetches should
use an app-owned safe fetch function; Provider response bodies have finite
limits by default.

Apps may also bind `revokeGrant` when they need to approve a grant-wide
revocation or coordinate app-specific cleanup. Without that hook, Cricket keeps
the Provider's normal access-token revocation behavior; grant-wide revocations
still remove the app's grant artifacts through `deleteGrantArtifacts`.

Cricket checks that protocol host paths do not overlap. Shared HTTP checks run
first, then protocol hosts run before ordinary app middleware so OAuth client
authentication remains Provider-owned. Apps can configure `responseHeaders`
and `requestPolicy` on `defineCricketApp` for the shared HTTP edge:

```js
import { defineCricketApp, respond, withHeaders } from '@robdel12/cricket';

let trustedOrigins = new Set(['https://console.example.test']);
let app = defineCricketApp({
  domains: './domains',
  responseHeaders(request) {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
  },
  requestPolicy({ request }) {
    let origin = request.headers.origin;
    if (request.method === 'OPTIONS' &&
        request.path.startsWith('/oauth') &&
        trustedOrigins.has(origin))
      return withHeaders(respond(204), {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin'
      });
  }
});
```

`responseHeaders(request)` runs once after Cricket normalizes the request and
returns plain default headers. Ordinary response headers override defaults
case-insensitively. Protocol hosts receive the same header record and apply
defaults after their own response policy, so explicit provider headers and
origin checks keep precedence; a host can reserve a header that its policy may
deliberately omit. A response-header policy cannot add headers to a request
that fails before Cricket can create normalized request facts.

`requestPolicy({ request })` runs before protocol hosts and ordinary middleware.
It returns `undefined` to continue, or an explicit Cricket response to end the
request. Use it for early shared decisions such as trusted-origin preflight.
Returning a response skips protocol dispatch and ordinary middleware for that
request; it is not a replacement for route authorization or general middleware.
Provider paths retain Provider-owned authentication and CORS checks. The MCP
Fetch transport remains an ordinary app endpoint and uses the same runtime
admission and shutdown lifecycle. Cricket waits for accepted HTTP requests
before closing the host; observer hooks such as `onGrantRevoked` are tracked and
drained rather than left as detached promises.

The host includes protocol mechanics and route ownership, not a consent UI or
product-specific grant model. Apps own client registration, durable Provider
storage, account/session policy, scopes, browser UI, and operational readiness.
See [`examples/oidc-provider-host.js`](./examples/oidc-provider-host.js) for the
setup and binding split.

## Add package domains with plugins

A package can export named Cricket domains for an app to compose with its own
domain folder. Keep Cricket as a peer dependency so the package and app use the
same Cricket contracts:

```js
// In the package, such as @acme/super-admin:
import {
  defineCricketPlugin,
  definePluginSchema,
  z
} from '@robdel12/cricket';

let UserPage = z.object({
  items: z.array(z.object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullable(),
    state: z.enum(['active', 'suspended'])
  })),
  nextCursor: z.string().nullable()
});

let superAdminSchema = definePluginSchema({
  services: {
    adminAccess: {
      requireAdmin: {
        input: z.unknown(),
        output: z.boolean()
      }
    },
    userSupport: {
      listUsers: {
        input: z.object({ search: z.string().optional() }),
        output: UserPage
      }
    }
  }
});

export let superAdminPlugin = defineCricketPlugin({
  name: 'super-admin',
  schema: superAdminSchema,
  domains: [userSupportDomain]
});
```

The app composes that descriptor beside its filesystem domains and maps its
own data into the shape declared by the plugin:

```js
import { defineCricketApp } from '@robdel12/cricket';
import { superAdminPlugin } from '@acme/super-admin';

export let app = defineCricketApp({
  domains: './domains',
  plugins: [superAdminPlugin],
  services({ services }) {
    return {
      ...services,
      adminAccess: {
        requireAdmin(request) {
          return request.headers['x-admin'] === 'true';
        }
      },
      userSupport: {
        async listUsers({ search }) {
          let rows = await services.productUsers.searchUsers({ search });

          return {
            items: rows.map(row => ({
              id: row.userId,
              email: row.primaryEmail,
              name: row.displayName,
              state: row.suspendedAt ? 'suspended' : 'active'
            })),
            nextCursor: null
          };
        }
      }
    };
  }
});
```

`defineCricketPlugin` copies the domain containers and freezes their structure.
Built contracts, schemas, and functions keep their identity. Cricket loads the
app's domain folder first, then adds plugin domains in the order listed. They
use the same HTTP, worker, inspect, and OpenAPI paths as app domains.

`definePluginSchema` describes the app service methods a plugin needs. Each method
declares one Zod input and output schema. The app provides those functions in
its service registry; Cricket checks that they exist when it builds the
runtime and validates each call. Plugin routes can use the same schemas for
their request and response contracts when those shapes match. The app maps its
own rows into the plugin's shared shape. If an app rule returns an authenticated
actor or trusted scope, pass those facts as explicit adapter input; do not take
trusted scope from request filters.

Plugins contribute domains only. They do not discover files or package paths,
register middleware or lifecycle hooks, or load migrations. A plugin model's
table still needs an app-owned migration. The app owns authentication and
product policy. It can connect plugin endpoints to app services for product
data and actions, so the package does not need a shared user, moderation, or
resource table.

Plugin descriptors do not serve browser files or styles. Export UI and CSS
separately and import them through the app's frontend build:

```js
import { SuperAdminRoutes } from '@acme/super-admin-ui';
import '@acme/super-admin-ui/styles.css';
```

The app owns route placement and the API client. Keep CSS paths out of
`defineCricketPlugin`.

### Add product pages to a shared admin

A shared admin can combine shared screens with product pages. Plugin schemas
validate the app service methods used by shared domains. Custom pages can use
their own domain endpoints and Zod contracts without a shared row schema.

The app owns routing, permissions, audit data and sessions. Each endpoint
validates and authorizes its requests. Navigation does not grant API access.
See [`examples/plugin-composition/`](examples/plugin-composition/) for shared
support actions combined with app-owned domains and service adapters.

## Domain Contracts

Models describe durable rows and default visibility:

```js
import { defineModel, field, z } from '@robdel12/cricket';

export let Project = defineModel({
  name: 'Project',
  table: 'project',
  row: {
    id: field.public(z.uuid()),
    owner_id: field.private(z.uuid(), { sensitive: true }),
    slug: field.public(z.string()),
    name: field.public(z.string())
  }
});
```

Validations are reusable Zod schemas for data entering a boundary:

```js
import { z } from '@robdel12/cricket';

export let ProjectCreateInput = z.object({
  slug: z.string().min(3),
  name: z.string().min(1)
});

export let ProjectInsert = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  slug: z.string().min(3),
  name: z.string().min(1)
});

export let ProjectParams = z.object({
  slug: z.string().min(3)
});
```

Normalizers turn outside payloads into app shapes. Serializers turn domain data
into API output shapes. Both should be pure.

```js
import { defineSerializer, pickFields } from '@robdel12/cricket';
import { Project } from './schema.model.js';

export let serializeProjectPublic = defineSerializer({
  name: 'project.public',
  output: Project.public,
  serialize: pickFields(['id', 'slug', 'name'])
});
```

Services do data and product work without knowing about HTTP:

```js
import { randomUUID } from 'node:crypto';
import { createKnexRepository } from '@robdel12/cricket';
import { Project } from './schema.model.js';
import { ProjectInsert } from './input.validations.js';

export function createProjectService({ db }) {
  let projects = createKnexRepository({
    db,
    model: Project,
    insert: ProjectInsert
  });

  return {
    async createForUser({ userId, slug, name }) {
      return await projects.insert({
        id: randomUUID(),
        owner_id: userId,
        slug,
        name
      });
    }
  };
}
```

Rules answer whether the request can continue. Routes compose validation, rules,
handlers, serializers, response contracts, and docs metadata.

```js
import { created, defineEndpoint, z } from '@robdel12/cricket';
import { Project } from './schema.model.js';
import { serializeProjectPublic } from './output.serializers.js';
import { ProjectCreateInput } from './input.validations.js';
import { requireUser, slugAvailable } from './access.rules.js';

export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  body: ProjectCreateInput,
  rules: [
    requireUser,
    slugAvailable
  ],
  response: z.object({
    success: z.literal(true),
    project: Project.public
  }),
  async handler({ input, services, user }) {
    let project = await services.projects.createForUser({
      userId: user.id,
      ...input.body
    });

    return created({
      success: true,
      project: serializeProjectPublic(project)
    });
  }
});
```

Definition builders reject unknown app and endpoint options so misspelled
wiring fails immediately instead of becoming unused metadata.

### Fetch endpoints

Use `fetch` for a handler that already speaks the Web Fetch API. Cricket keeps
the Node socket bridge private, runs normal route matching and access rules,
and passes a standard `Request` plus the usual endpoint context. The handler
must return a standard `Response`.

```js
import { defineEndpoint } from '@robdel12/cricket';

export let stream = defineEndpoint({
  method: 'post',
  path: '/stream',
  maxBodyBytes: 1024 * 1024,
  fetchResponses: {
    200: {
      description: 'JSON or event stream',
      contentTypes: ['application/json', 'text/event-stream']
    }
  },
  fetch(request, { request: cricketRequest, services }) {
    return services.stream.handle(request, {
      requestId: cricketRequest.id,
      host: cricketRequest.host,
      origin: cricketRequest.origin
    });
  }
});
```

Fetch request bodies stay streamed and are limited by `maxBodyBytes` (10 MiB
by default). The Request body remains available through the response stream, so
a handler can return a Response that streams that body. Cricket applies
backpressure between the Web stream and the Node response, preserves repeated
`Set-Cookie` headers, and cancels the Fetch signal on disconnect or shutdown.
If an upload is still incomplete when the response finishes, Cricket closes
that connection instead of racing a second reader against the Fetch body.
Every Fetch endpoint declares statuses in `fetchResponses`. It lists supported
media types and adds them to OpenAPI without claiming a body schema. Cricket
checks the status and declared content type without buffering or parsing the
response body. Fetch endpoints reject parsed `response` and `responses`
schemas; use `fetchResponses` for this transport contract.

Use one `fetchResponses` entry per status and list the media types that status
can return.

### Endpoint API versions

API versioning is endpoint-owned and optional. A shared immutable version
family names the request header, current contract, pinned default, and supported
versions. It is not registered on `defineCricketApp`.

```js
import { defineApiVersions } from '@robdel12/cricket';

export let sdkVersions = defineApiVersions({
  name: 'project.sdk',
  header: 'Project-Version',
  clientHeader: 'Project-SDK-Version',
  current: '2026-09-01',
  default: '2025-11-15',
  versions: {
    '2025-11-15': {
      deprecatedAt: '2026-09-01',
      sunsetAt: '2027-09-01'
    },
    '2026-09-01': {}
  }
});
```

The endpoint's `body`, `response`, and `responses` define the base contract.
Historical entries contain only the compatibility work that endpoint needs.
Body normalizers must reuse the endpoint's `body` schema as their `output`;
Cricket parses it once and rejects skipped (null/undefined) results.
OpenAPI includes the shorthand default `response` alongside the status-specific
`responses`. A status-specific entry takes precedence when both declare the
same status.

By default, the response schema validates both canonical data and current public
output. When those shapes differ, pair a canonical schema with a current serializer:

```js
let currentReport = defineSerializer({
  name: 'report.current',
  output: z.object({ id: z.string(), title: z.string() }),
  serialize: value => ({ id: value.id, title: value.title })
});

let response = {
  schema: ReportData, // Validated data needed by supported representations.
  serializer: currentReport
};
```

Use this definition in `response` or under a status in `responses`. Cricket
validates the handler result first, then runs exactly one serializer: the
historical override when present, otherwise the base serializer. Each serializer
validates its own public output. Fields removed by canonical validation stay
removed. OpenAPI describes the selected serializer's output, not `ReportData`.
A serializer requires a canonical Zod schema and must come from `defineSerializer`.
The current serializer belongs in the base response, not an `apiVersions` override.

Endpoint rules, including `beforeBodyRules`, and handlers receive the negotiated
`apiVersion`. Use it at that boundary to choose explicit data requirements before
calling a service. Services receive those requirements, not API versions. Field
selection and loading policy stay in the app; use schemas that require the facts
each selected response promises instead of making every field optional.

Keep these adapters pure and explicit. Their context is trusted app context;
Cricket cannot prevent app code from intentionally loading or returning private
data. Review every supported projection and test authorization through HTTP.
Version deltas cover body and handler response shape only; params, query,
rules, thrown framework errors, and transport behavior remain shared.

```js
export let createProject = defineEndpoint({
  method: 'post',
  path: '/projects',
  apiVersions: sdkVersions({
    '2025-11-15': {
      body: normalizeLegacyProjectCreate,
      responses: {
        201: serializeLegacyProject,
        202: serializeLegacyQueuedProject
      }
    }
  }),
  body: ProjectCreateInput,
  responses: {
    201: ProjectResponse,
    202: QueuedProjectResponse
  },
  rules: [requireUser],
  handler: createProject
});
```

Use `apiVersions: sdkVersions()` on an unchanged endpoint when it should still
negotiate the family and report usage. Omit `apiVersions` entirely when an
endpoint should ignore version headers. Unsupported or ambiguous values fail
with a bounded bad request; unknown raw values are not logged or echoed.
Use dedicated version headers, distinct from credentials and transport headers.
Version identifiers are exact visible ASCII strings without commas (128 chars
maximum); the optional client version is bounded telemetry, not trusted identity.

Cricket adds the effective version and `Vary` response headers, and attaches
the selected family/version to route logs and traces. The optional client header
is bounded telemetry only and never selects the API contract. Generate an exact
OpenAPI contract with:

```sh
pnpm cricket docs api/index.js \
  --api-version project.sdk=2026-09-01 \
  --out openapi.json
```

Deprecation and sunset dates announce policy; they do not disable versions on
a timer. To retire a version, remove its family entry and endpoint deltas, and
update the pinned default if necessary. Requests naming that version then fail
with 400. Regenerate each published version's OpenAPI after changing contracts.

When compatibility is no longer needed, remove the endpoint's `apiVersions`
option and eventually delete the unused family definition. Old clients may
continue sending the now-unused header; ordinary endpoints ignore it.

### Endpoint responses

Bare values returned by handlers, middleware, and fallbacks are response bodies.
Only Cricket's response functions control HTTP transport details, so a domain
object containing fields such as `status`, `headers`, or `redirect` stays a
normal JSON body.

Throw framework errors such as `badRequest` for invalid input. Cricket maps error
codes to HTTP statuses; an arbitrary error's `status` property does not choose its
response. Request validation can explain invalid input to clients. Response,
serializer, and normalizer failures stay internal and return a redacted 500.

```js
import {
  ok,
  redirect,
  respond,
  withCookies,
  withError,
  withHeaders,
  withResponseBody,
  withResponseHeaders,
  withResponseCleanup
} from '@robdel12/cricket';

return withHeaders(respond(202, {
  queued: true
}), {
  'Retry-After': '5'
});

return withCookies(ok({
  signedIn: true
}), [{
  name: 'session',
  value: session.id,
  options: {
    httpOnly: true,
    secure: true
  }
}]);

return redirect('/projects', 303);

return withResponseCleanup(
  withHeaders(ok(stream), {
    'Content-Type': 'text/event-stream'
  }),
  () => stream.destroy()
);
```

When a policy replaces a response body after validation, `withResponseBody`
keeps the explicit response's status, cookies, headers, redirect, cleanup, and
handled-error metadata. `withResponseHeaders` replaces the complete header set;
use it when the new body makes an earlier header such as `Content-Length`
invalid. Cookies and cleanup stay attached to the response.

For a file with a known byte length, set `Content-Length` alongside the stream.
Cricket forwards chunks with backpressure and checks the declared size. A short
or oversized source closes the response and runs its cleanup. HEAD preserves the
length without reading the source. Leave the header out for open-ended streams.
See [`examples/known-length-stream.js`](examples/known-length-stream.js).

When a catch returns a friendly error response, retain its exception with
`withError`:

```js
try {
  return await loadImage();
} catch (error) {
  return withError(respond(503, { error: 'Image could not be loaded' }), error);
}
```

`withError` accepts explicit 400–599 responses and keeps the error outside the
body. It survives headers, cookies, and valid response projections, but never
bypasses validation. Declare distinct success/error bodies with status-specific
`responses`; a mismatched body still produces a contract failure and 500.
[Configure HTTP reporting](#http-error-reporting) once on the app.

### Multipart requests

Endpoints that accept uploads can opt into bounded multipart parsing:

```js
let upload = defineEndpoint({
  method: 'POST',
  path: '/uploads',
  beforeBodyRules: [requireProjectToken],
  multipart: {
    maxBytes: 50 * 1024 * 1024,
    maxFiles: 10,
    maxFileBytes: 50 * 1024 * 1024,
    maxFields: 50
  },
  handler({ request }) {
    return created({
      fields: request.body,
      files: request.files.map(file => ({
        fieldName: file.fieldName,
        originalName: file.originalName,
        mimeType: file.mimeType,
        path: file.path,
        size: file.size
      }))
    });
  }
});
```

Multipart fields are plain values; repeated fields become arrays. Files are streamed to temporary
files and exposed through `request.files` during the handler. Cricket removes those files after the
endpoint returns, including when parsing or validation fails. Set `maxBodyBytes`, `maxFileBytes`,
`maxFieldBytes`, `maxFiles`, and `maxFields` for the upload's actual limits.

Use `beforeBodyRules` for authentication and other inexpensive checks that must pass before Cricket
accepts an upload. These rules receive request headers, route parameters, and app context, but no
parsed body. Their returned facts are available to the endpoint's remaining rules and handler.

A rejected upload can receive its error response before sending the entire body. Cricket
discards the remaining bytes without storing them, within the endpoint's body limit. This
discard remains part of the accepted request until the body ends, the client disconnects,
the limit is exceeded, or the host HTTP server closes the connection on timeout. Keep the
host's request timeout enabled. Reusable connections can serve another request after the
body ends; connections requested closed finish the response and discard before closing.
No multipart files are created when a before-body rule rejects the upload. If the client
disconnects while a rule runs, body parsing rejects once the rule finishes.

## Database

Cricket uses Knex as the database path. It creates one `db` handle for the
runtime, passes it through app capabilities, and destroys it during cleanup.

Migrations live in `api/migrations/` by convention:

```sh
pnpm cricket migrate make api/index.js create_projects
pnpm cricket migrate latest api/index.js
pnpm cricket migrate status api/index.js
pnpm cricket migrate rollback api/index.js
```

Cricket does not run migrations on server start, design tables, hide data
policy, or replace Knex. It makes the database contract visible from the same
app definition your server uses.

## Jobs

Jobs are Cricket contracts for background work. Use them when work needs
validated input, immutable envelopes, explicit queue coordination, scheduled
execution, recovery, failure handling, logs, traces, progress, and the same
services your HTTP handlers use.

```js
import { z } from '@robdel12/cricket';
import {
  concurrency,
  createCricketJobs,
  cronSchedule,
  defineJob,
  jobFailure,
  redisQueue,
  retry
} from '@robdel12/cricket/jobs';

export let generateReport = defineJob({
  name: 'reports.generate',
  input: z.object({
    reportId: z.string(),
    accountId: z.string()
  }),
  context: z.object({
    priority: z.number().int().default(0)
  }).default({}),
  queue: redisQueue({
    name: 'reports',
    idempotencyKey: ({ input }) => input.reportId,
    priority: ({ context }) => context.priority
  }),
  concurrency: [
    concurrency.global({
      key: 'reports:rendering',
      limit: 4
    }),
    concurrency.partition({
      key: ({ input }) => `account:${input.accountId}`,
      limit: 1
    })
  ],
  retry: retry.exponential({
    attempts: 3,
    delayMs: 2_000,
    maxDelayMs: 60_000
  }),
  recover({ run, logs, progress }) {
    if (run.heartbeatAgeMs > 2 * 60_000)
      return {
        action: 'retry',
        reason: {
          code: 'heartbeat_stale',
          message: 'worker heartbeat is stale'
        }
      };

    if (run.ageMs > 5 * 60_000 && !logs.seen('report.started', { within: '5 minutes' }))
      return {
        action: 'retry',
        reason: {
          code: 'report_never_started',
          message: 'report job never started'
        }
      };

    if (run.ageMs > 10 * 60_000 && !progress.seen({ within: '10 minutes' }))
      return {
        action: 'retry',
        reason: {
          code: 'report_not_advancing',
          message: 'report job stopped reporting progress'
        }
      };

    return { action: 'continue' };
  },
  failure: jobFailure({
    async exhausted({ input, failure, services }) {
      await services.reports.markFailed({
        reportId: input.reportId,
        reason: failure.message
      });
    }
  }),
  schedule: cronSchedule({
    key: 'daily-reports',
    cron: '15 4 * * *',
    timezone: 'America/Chicago',
    input: ({ scheduledFor }) => ({
      reportId: `daily:${scheduledFor.slice(0, 10)}`,
      accountId: 'system'
    })
  }),
  async run({ input, logger, services, trace, progress }) {
    logger.info('report.started', {
      reportId: input.reportId
    });
    await progress.update({ current: 1, total: 1 });
    return trace.span('reports.generate', {
      accountId: input.accountId
    }, () => services.reports.generate(input));
  }
});
```

Producer entrypoints enqueue without starting a worker:

```js
let producer = await createCricketJobs({
  jobs: [generateReport],
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  }
});

await producer.jobs.enqueue(generateReport, {
  reportId,
  accountId
});
```

Worker entrypoints execute jobs:

```js
import { startCricketWorker } from '@robdel12/cricket/jobs';
import { app } from '../index.js';
import { generateReport } from '../domains/reports/reporting.jobs.js';

let worker = await startCricketWorker(app, {
  queues: {
    redis: {
      url: process.env.REDIS_URL
    }
  },
  jobs: [generateReport]
});

let shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());

try {
  await worker.run({
    signal: shutdown.signal
  });
} finally {
  await worker.cleanup();
}
```

In domain architecture, a worker may execute all app jobs or select a subset,
but every selected job must belong to one of the app's resolved domains,
including plugin domains. Manual apps may register jobs at the worker boundary
while they migrate that ownership.

Choose the queue deliberately. Production producers and workers use
`queues.redis` or an app-provided `queues.driver`; tests opt into the in-memory
driver with `queues.test: true`. Cricket never silently turns a missing queue
configuration into an in-memory worker.

The built-in Redis client accepts `redis://` and `rediss://` URLs, including ACL
credentials and a numeric database path. `rediss://` verifies certificates by
default; pass Node TLS options as `queues.redis.tls` when the deployment uses a
private CA. An app-provided client must implement `duplicate()` so blocking
wakeups never stall normal Redis commands. The built-in driver targets a
standalone Redis primary; Redis Cluster is not supported by the built-in
driver.

`worker.run({ signal })` blocks on queue wakeups and the next delayed or cron
boundary. Enqueuing ready work wakes it immediately. Aborting the signal or
calling `worker.cleanup()` stops the wait without a polling interval.
Between jobs, the continuous worker rechecks recovery, due cron slots, and
delayed availability, so a ready backlog cannot postpone those checks until
the queue empties. `worker.drain()` still runs all currently ready work for
explicit workflow tests.

Exponential retries use the job policy as execution behavior. The first retry
waits `delayMs`, each later retry doubles that delay, and `maxDelayMs` caps it.
The retry stays unclaimable until that calculated availability time, while the
original immutable envelope stays unchanged.

Queue policy travels with that immutable envelope. Claims prefer higher numeric
priority among the ready work observed for that claim; equal priorities use
creation time and then envelope ID for stable order. Work enqueued during a
claim becomes eligible on the next claim.

Global concurrency limits shared work, while partition limits keep one account
or tenant from consuming all capacity. A blocked partition does not prevent
another partition from running. Drivers evaluate the resolved envelope policy
when choosing work. Redis atomically verifies and reserves capacity for the
selected envelope, so simultaneous workers cannot over-claim a shared limit.

An idempotency key owns one unfinished run. Duplicate enqueue attempts return
the existing envelope while it is queued, delayed, active, or retrying. Cricket
releases the key after completion or final failure so a later run can start.
Each claimed attempt owns Cricket's lease, evidence, retry, and
completion/failure writes; the driver rejects those writes from older attempts.
Apps must still make product-side effects idempotent or attempt-aware. Delayed
promotion and schedule-slot materialization use the same atomic coordination
boundary.

Envelopes, run state, events, current-attempt evidence, and schedule-slot
ownership remain after a job completes or fails. The app chooses how long to
keep that execution history and when cleanup runs. Pass the expired ledger IDs
to `jobs.removeFinished(ids)`; Cricket verifies each job is completed or failed
and removes its Redis records without exposing their key layout. The result
separates `removed`, already-`missing`, and `skipped` IDs. Treat both `removed`
and `missing` as safe to delete from `cricket_jobs`; leave `skipped` rows for a
later run or operator review.

Run Redis cleanup before deleting ledger rows. If cleanup stops between those
steps, the next run reports the already-clean Redis IDs as `missing` and can
finish deleting the rows. Keep completed and failed retention windows, batch
size, and cleanup scheduling in app code.

```js
async function removeExpiredJobHistory({ jobs, jobHistory, policy }) {
  let expired = await jobHistory.expired(policy);
  let result = await jobs.removeFinished(expired.map(row => row.id));

  await jobHistory.removeExpired([
    ...result.removed,
    ...result.missing
  ], policy);

  return result;
}
```

The app service should recheck the job status and applicable cutoff when it
deletes each row. Cricket does not choose retention windows or schedule this
work.

The built-in Redis driver exposes an explicit command-connection check through
both producer and worker controls:

```js
let connection = await producer.driver.checkConnection();
// Or: await worker.driver.checkConnection()
// Frozen result: { status: 'connected' | 'disconnected' | 'closed' }
```

`connected` means the existing command connection answered `PING` with `PONG`.
`disconnected` means that check failed. `closed` means driver cleanup has begun,
even when an app-supplied Redis client remains open. The check does not open a
connection, reconnect, inspect job payloads, or run periodically. It does not
check the blocking-wait connection, worker progress, or the claim loop. Apps
combine this fact with their own ledger, capacity, and readiness checks. Custom
and test drivers do not automatically provide this Redis-specific operation.
See [the queue connection example](examples/queue-connection.js).

`worker.cleanup()` closes runtime resources and driver-owned Redis connections;
the app still owns any client it supplied. Cleanup does not delete coordination
records.

If the app has a Cricket database, add the job ledger deliberately:

```js
import { createJobLedgerTable } from '@robdel12/cricket/jobs';

export async function up(db) {
  await createJobLedgerTable(db);
}

export async function down(db) {
  await db.schema.dropTableIfExists('cricket_jobs');
}
```

The ledger is execution history for debugging and operators. It is not product
state. Producer enqueue and worker lifecycle inserts are race-safe, so a fast
claim cannot collide with a late queued insert or regress an active row back to
queued.

Recovery is app-owned. Cricket renews an active claim's heartbeat while its
`run` function is working and records normal logs, spans, progress, and driver
run state. Your `recover` function reads that snapshot, including heartbeat age
and ledger-shaped run facts, then returns a plain decision:

```js
return { action: 'continue' };
return { action: 'retry', reason: { code: 'worker_lost' } };
return { action: 'fail', reason: { code: 'outside_business_window' } };
```

Use logs for domain breadcrumbs, `trace.span()` for timed work, and
`progress.update()` for human-readable progress. Cricket does not define
"stuck" for you. The job does. Multiple recoverers may evaluate the same
attempt, so keep recovery pure and idempotent. Cricket fences the resulting
transition and reports `applied: false` when a live attempt still owns its
lease. The optional `cricket_jobs` database ledger remains separate execution
history; recovery does not require it.

## Observability

Cricket supplies structured logs, request/job traces, HTTP error reporting, and
lifecycle state. `cricket inspect` shows which observers and error hook are
configured.

### Logging and tracing

```js
export let app = defineCricketApp({
  domains: './domains',
  logger: {
    service: 'project-api',
    level: process.env.LOG_LEVEL ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty'
  }
});
```

`format: 'pretty'` is for local development. It prints a short UTC timestamp,
level, service, and event, followed by the job name or HTTP method, path, and
status. Spans show their name, duration, and result. Metadata uses indented
`key=value` fields and readable nested objects; full correlation IDs stay in
the details, and repeated span context appears only once. Each `write` call
receives one complete event, which can span multiple lines.

```text
17:54:00.375Z INFO  [Radar Worker] radar.counts · radar.refresh
  queueName=radar-live  attempt=1  warning_count=0  source_cached=true
17:54:00.378Z INFO  [Radar Worker] trace.span.finished · radar.refresh · radar.fetch · 367.576ms · ok
  span: { id: 'd8c9c565-f6ea-4260-8d54-8acf4a58b0b5', startMs: 1.414 }
  jobRunId=jobrun_1853d626-11ac-45f4-9fad-063a3bcbe4e8
```

Pretty output uses color when stdout is a terminal and `NO_COLOR` is unset.
Set `logger.color` to `true` or `false` to override detection, including for a
custom writer. `format: 'json'` remains the default and keeps the complete
structured envelope on one line, without color. Use JSON for log collectors
and `cricket trace`.

Use `trace.span(name, metadata, fn)` around meaningful service calls, external
calls, and job steps. Use `pnpm cricket trace` when you need to inspect one
request from newline-delimited JSON logs:

```sh
docker logs api | pnpm cricket trace req_123
```

Apps can read `lifecycle` from setup, services, middleware, context, handlers,
job execution, and shutdown hooks. Worker runtimes expose it for worker
entrypoints. Product health checks still decide whether the app is ready for
traffic.

### HTTP error reporting

Set `onError` on the app to report thrown HTTP failures and errors attached with
`withError`. The hook receives the original exception and request-scoped context:

| Context | Meaning |
| --- | --- |
| `request`, `response` | The request and selected response, when available. |
| `route` | Matched method, path template, and operation ID; absent before matching. |
| `handled` | `true` when the error came from `withError`. |
| `phase` | `request` during execution; `response` for later writing or cleanup failures. |
| `logger` | Cricket's logger for this request. |

The hook may be async. Cricket awaits it and logs reporter failures without
changing the response. An error is reported once per request phase: cleanup is a
separate failure even if it reuses an earlier exception. Attaching an error does
not serialize or freeze it. A plain 500 body carries no exception to report.

For Sentry, pass your SDK to the optional adapter. This exception-reporting example
initializes it in setup, keeping CLI inspection free of SDK initialization:

```js
import { defineCricketApp } from '@robdel12/cricket';
import { sentryErrorHandler } from '@robdel12/cricket/sentry';
import * as Sentry from '@sentry/node';

export let app = defineCricketApp({
  domains: './domains',
  onError: sentryErrorHandler(Sentry),
  setup() {
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
    return { cleanup: () => Sentry.flush(2000) };
  }
});
```

Cricket adds no Sentry dependency or process handlers. Apps own SDK options,
environment policy, and scrubbing. Initialize automatic instrumentation in your
startup entrypoint before loading app dependencies if you use it.

The adapter skips request-phase 4xx failures and reports every response-phase
failure, including cleanup after a 200 or 400. It adds method, status, operation
ID, request ID, and a matched route template. It adds no raw paths, headers,
cookies, query values, or bodies. Original exceptions can contain sensitive
messages, custom properties, or causes; the SDK's filtering policy owns those.

SDK flushing follows the [normal cleanup order](#pausing-requests-and-stopping-servers).
Background jobs and detached work keep their own failure hooks. See the
[custom hook example](examples/error-reporting.js).

### Pausing requests and stopping servers

`createCricketRuntime(app)` resolves when app assembly is ready.
`startCricketApp(app, { port: 0, host: '127.0.0.1' })` also waits for its HTTP
listener and returns the bound `origin`. Use that value instead of waiting for
another `listening` event or guessing the port.

Pause admission while an owner changes shared app state:

```js
let hold = runtime.requests.pause();
await hold.idle({ signal });
await resetAppState();
hold.resume();
```

New requests receive 503 before middleware or handlers run. Every independent
hold must resume before admission reopens. Aborting `idle` leaves the hold
closed; the owner can await it again. Only resume after successful work. Keep
control operations outside the paused runtime so they do not block themselves.
Paused responses do not run app middleware or acquire its computed headers.

Idle includes awaited middleware, handlers, error hooks, response streams,
bounded discard of unread request bodies, asynchronous `withResponseCleanup`
callbacks, and terminal observers. A client disconnect does not cancel an
in-flight write: Cricket keeps owning that work until it settles. Ordinary client
stream cancellation does not fail draining when cleanup succeeds. Producer and cleanup errors are logged and passed to
`onError`, then reject the next relevant idle or cleanup boundary. Once that
boundary reports them, later holds do not repeat the same errors.

`runtime.cleanup()` closes admission, waits for accepted requests, and releases
setup dependencies once. For a server from `startCricketApp`, use `stop(signal)`:
it also stops listening and calls `onShutdown({ signal, ...runtime })` before
waiting for requests. That hook must stop independent producers and end long
streams. Setup cleanup then releases app resources and flushes reporting SDKs;
use `finally` to flush even if resource cleanup fails. Cricket destroys its
configured database afterward. Cleanup attempts remaining steps after failures
and preserves their errors. A resumed hold cannot reopen a stopped runtime.

Request holds leave `lifecycle` ready; product health and maintenance policy
remain app decisions. Detached promises, jobs, queues, database reset policy,
and listeners around Cricket remain explicitly owned by the app. See
[`examples/request-pause.js`](examples/request-pause.js) for a small complete example.

## Testing

Test through the boundary users consume. Use HTTP tests for endpoints and the
worker boundary for jobs.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestRuntime } from '@robdel12/cricket/test';
import { createOidcProviderHost } from '@robdel12/cricket/oidc-provider';
import { app } from '../api/index.js';

test('creates a project through the API', async () => {
  let { api, cleanup, testState } = await createTestRuntime(app);

  try {
    let response = await api.post('/api/projects', {
      body: {
        slug: 'launch-plan',
        name: 'Launch Plan'
      }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.project.slug, 'launch-plan');

    let request = testState.request(response.requestId);
    assert.equal(request.response.status, 201);
  } finally {
    await cleanup();
  }
});
```

The harness and its client expose the same `origin` for browser or HTTP clients.
`cleanup()` closes the test listener and joins the runtime's accepted work before
releasing dependencies. It runs once, and it does not call the standalone
server's `onShutdown` hook. Stop app-owned workers and long-lived streams before
cleanup; the harness does not reset databases or discover detached jobs.

Drive scheduled jobs without waiting on wall time:

```js
let worker = await startCricketWorker(app, {
  jobs: [generateReport],
  queues: {
    test: true
  },
  clock: {
    now: () => new Date('2026-06-19T09:16:00.000Z')
  }
});

await worker.schedules.tick();
await worker.drain();
```

Direct `tick()` and `drain()` tests only need `clock.now`. If a test exercises
the continuous `worker.run()` loop with a custom clock, provide
`clock.waitUntil` too so the test owns deadline advancement without sleeping.

`testState` exposes events, logs, request traces, job traces, timings, and
runtime reports. It does not reset app state for you.

## CLI

```sh
pnpm cricket init .
pnpm cricket new domain project api/domains --with model,validations,service,routes,test
pnpm cricket inspect api/index.js
pnpm cricket check api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate latest api/index.js
pnpm cricket test
```

`new domain` requires `--with` so optional files exist only when the domain
needs them; use `--with all` when every supported file is intentional. A
selected test starts as a todo until it proves behavior through the HTTP or
worker boundary. The serializer scaffold requires a model in the same selection
or an existing `schema.model.js` in the domain.
`check` validates the app architecture and calls out manual migration debt.
`inspect` prints architecture, loaded domains, model visibility, rules, services, jobs, route
operation IDs, and observability posture. `docs` writes OpenAPI from the same
app module your server runs. `test` wraps Node's built-in test runner with
Cricket defaults and optional JSON output.

## Document your HTTP API

Run `cricket docs api/index.js` to generate OpenAPI 3.1 without starting your
server or running setup. It includes every registered endpoint, so choose which
endpoints to include before publishing public docs.

### Describe authentication and headers

```js
let showReport = defineEndpoint({
  method: 'get',
  path: '/reports/:id',
  params: z.object({ id: z.string() }),
  headers: z.object({ 'x-client-version': z.string().optional() }),
  auth: [{ bearer: [] }],
  rules: [requireUser],
  response: {
    schema: Report.public,
    headers: { 'Cache-Control': { schema: z.string(), example: 'private, no-store' } }
  },
  handler: async context => withHeaders(ok(await reports.find(context.input.params.id)), {
    'Cache-Control': 'private, no-store'
  })
});

let app = defineCricketApp({
  authMethods: { bearer: { type: 'http', scheme: 'bearer' } },
  domains: [{ name: 'report', endpoints: [showReport] }]
});
```

`authMethods` names the app's authentication methods. Endpoint `auth`
describes which ones a request needs. Rules and middleware enforce access.
Generated OpenAPI uses the standard `securitySchemes` and `security` names.

Methods in one object are required together; separate array entries are
alternatives. `auth: []` documents anonymous access. Cricket supports HTTP,
API key, OAuth 2, OpenID Connect, and mutual TLS descriptions.

Use lowercase names in request `headers`. Cricket validates only those headers
and puts the parsed values in `input.headers`; missing or invalid required
values return 422. Rules can read raw credentials from `request.headers`.
Describe `authorization` through authentication methods, and `accept`/`content-type`
through content types.

Response definitions accept `schema` (or `body`), `serializer`, `description`,
`contentType`, `headers`, and `example`, including under status-specific `responses`. Each
header needs a schema and can have a description or example. Return its actual
value with `withHeaders`. HEAD, 204, 205, and 304 responses have no documented body.

### Describe custom types

```js
let BinaryFile = z.instanceof(Buffer).meta({
  jsonSchema: { type: 'string', format: 'binary' }
});

// The handler also sets this Content-Type with withHeaders.
let response = { schema: BinaryFile, contentType: 'application/octet-stream' };
```

Cricket documents Zod input types for requests and output types for responses.
A string transformed to a number is a string request or numeric response;
response dates become date-time strings.

If Cricket can't describe a transform or custom type, docs generation fails.
Add a known output type with `.pipe(...)` or describe the sent value with
`jsonSchema` metadata, as above. This metadata doesn't change validation or
serialization, so check it against a real HTTP response.

Input coercion also needs metadata because JavaScript accepts more than the
resulting type suggests. For a numeric query parameter, use
`z.coerce.number().meta({ jsonSchema: { type: 'number' } })`.

### Describe uploads and raw bodies

```js
let body = z.object({ label: z.string() });
let requestBody = {
  files: {
    type: 'object',
    properties: { asset: { type: 'string', format: 'binary' } }
  }
};
// Use these with multipart: { maxFiles: 1, maxFileBytes: 1048576 }.
```

`requestBody` adds a `description`, `example`, or `contentType` to the `body`
schema. JSON is the default; multipart endpoints use `multipart/form-data`.

`files` accepts `type`, `properties`, and optional `required`. File names can't
overlap body fields. Rules check required files, MIME types, and contents;
Cricket enforces the configured size and count limits.

For raw requests, set `rawBody` and describe the input with `requestBody.schema`
and a content type such as `text/plain`. Rules validate the raw data.
`requestBody.required` only changes the docs; by default, it follows whether
`body` accepts a missing value.

### Check the generated docs

Model components include public schemas and views containing only public fields.
Review endpoint responses and examples too: they can still declare private data.
Cricket copies and freezes documentation metadata without freezing your objects.

Versioned docs keep auth, headers, descriptions, and content types. When an
older normalizer or serializer replaces a schema, Cricket drops its current
body/response example. Put version-specific examples on that version's Zod schema.

Duplicate operations/components, conflicting route parameters, unknown auth
methods, and broken local references fail generation. Use document JSON pointers
for references you write yourself. Cricket moves recursive Zod schemas, including
`z.json()`, into OpenAPI components and keeps their local references intact.
Generated component names are internal; don't hardcode them. Cricket doesn't
fetch external references.

See [the public API example](examples/public-contracts.js).

## Exports

```js
import {
  defineCricketApp,
  startCricketApp,
  createCricketRuntime,
  defineApiVersions,
  defineEndpoint,
  deprecateEndpoint,
  respond,
  ok,
  created,
  redirect,
  withHeaders,
  withCookies,
  withError,
  withResponseCleanup,
  defineModel,
  defineRule,
  defineSerializer,
  defineNormalizer,
  field,
  createKnexRepository,
  z
} from '@robdel12/cricket';

import {
  concurrency,
  createCricketJobs,
  createJobLedgerTable,
  cronSchedule,
  defineJob,
  jobFailure,
  redisQueue,
  retry,
  startCricketWorker,
  state
} from '@robdel12/cricket/jobs';
```

Public subpaths are also available:

```js
import { defineCricketApp } from '@robdel12/cricket/app';
import { loadDomains } from '@robdel12/cricket/domain';
import { createKnexRepository } from '@robdel12/cricket/knex';
import { createCricketLogger, normalizeLogger } from '@robdel12/cricket/logger';
import { generateOpenApi } from '@robdel12/cricket/openapi';
import { defineSerializer } from '@robdel12/cricket/serializer';
import { sentryErrorHandler } from '@robdel12/cricket/sentry';
import { createTestRuntime } from '@robdel12/cricket/test';
import { createOidcProviderHost } from '@robdel12/cricket/oidc-provider';
```
