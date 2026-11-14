import { Provider, errors } from 'oidc-provider';
import Koa from 'koa';
import mount from 'koa-mount';
import { z } from 'zod';
import { readRequestBody } from './http/request.js';
import { defineProtocolHost } from './protocol-host.js';

let requestFactsSchema = z.object({
  method: z.string(),
  path: z.string(),
  host: z.string(),
  origin: z.string(),
  ip: z.string().nullable(),
  clientIp: z.string().nullable(),
  peerIp: z.string().nullable(),
  proxyTrusted: z.boolean(),
  protocol: z.enum(['http', 'https']),
  secure: z.boolean(),
  browserCredential: z.string().nullable()
});

let jsonValueSchema = z.custom(isJsonValue, { message: 'Expected a plain JSON value' });

let jsonRecordSchema = jsonValueSchema.pipe(z.record(z.string(), jsonValueSchema));

let interactionSchema = jsonValueSchema.pipe(z.object({
  uid: z.string(),
  params: z.record(z.string(), jsonValueSchema),
  prompt: z.object({ name: z.string(), details: z.record(z.string(), jsonValueSchema) }),
  result: jsonRecordSchema.nullable()
}).strict());

function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    ancestors.add(value);
    let valid = value.every(item => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  let prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)))
    return false;
  ancestors.add(value);
  let valid = Object.values(value).every(item => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function requestFacts(ctx, browserCredentialCookie, { includeBrowserCredential = false } = {}) {
  return requestFactsSchema.parse({
    method: ctx.method,
    path: ctx.path,
    host: ctx.host,
    origin: ctx.get('origin'),
    ip: ctx.ip || null,
    clientIp: ctx.request.clientIp,
    peerIp: ctx.request.peerIp,
    proxyTrusted: ctx.request.proxyTrusted,
    protocol: ctx.protocol,
    secure: ctx.secure,
    browserCredential: includeBrowserCredential && browserCredentialCookie
      ? ctx.cookies.get(browserCredentialCookie, { signed: false }) ?? null
      : null
  });
}

let frameworkErrorStatuses = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  TOO_MANY_REQUESTS: 429
};

function hookError(ctx, error) {
  let mappedStatus = Number.isInteger(error?.status) ? error.status : frameworkErrorStatuses[error?.code];
  ctx.status = Number.isInteger(mappedStatus) && mappedStatus >= 400 && mappedStatus <= 599
    ? mappedStatus
    : 503;
  if (ctx.status >= 500) ctx.state.cricketProtocolError = error;
  ctx.body = {
    error: ctx.status < 500 && typeof error?.message === 'string'
      ? error.message
      : 'Authorization is temporarily unavailable.',
    ...(ctx.status < 500 && typeof error?.code === 'string' ? { code: error.code } : {})
  };
}

function requestBodyError(ctx, error) {
  if (error?.code === 'PAYLOAD_TOO_LARGE') {
    ctx.status = 413;
    ctx.body = { error: 'Request is too large.' };
    return;
  }
  hookError(ctx, error);
}

let requestOutcomeSchema = jsonValueSchema.pipe(z.object({ status: z.number().int().min(200).max(599) }).strict());
let identifierSchema = z.string().min(1).max(8192);
let scopeListSchema = z.array(z.string().min(1).max(256));
let accessTokenFactsSchema = z.object({
  accountId: z.string().nullable(),
  aud: z.union([z.string(), z.array(z.string())]).nullable(),
  clientId: z.string().nullable(),
  grantId: z.string().nullable(),
  isExpired: z.boolean(),
  scope: z.string().nullable()
}).strict();
let grantFactsSchema = z.object({
  accountId: z.string().nullable(),
  clientId: z.string().nullable(),
  isExpired: z.boolean()
}).strict();
let savedGrantSchema = z.object({ id: identifierSchema, expiresAt: z.date() }).strict();

function requestOutcome(value) {
  if (value === undefined) return undefined;
  return requestOutcomeSchema.parse(value);
}

function interactionFacts(details) {
  return interactionSchema.parse({
    uid: details.uid,
    params: details.params,
    prompt: {
      name: details.prompt?.name ?? '',
      details: details.prompt?.details ?? {}
    },
    result: details.result ?? null
  });
}

function clientFacts(client) {
  return clientFactsSchema.parse({
    clientId: client.clientId,
    clientName: client.clientName ?? null,
    clientUri: client.clientUri ?? null
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function interactionRoute(path, paths) {
  return new RegExp(`^${escapeRegex(paths.interaction)}/([^/]+)(?:/(details|decision))?$`).exec(path);
}

function routeName(path, match, paths) {
  if (path === paths.resourceMetadata) return 'resource_metadata';
  if (path === paths.authorizationMetadata) return 'authorization_metadata';
  if (match) return match[2] === 'decision' ? 'interaction_decision' : 'interaction_details';
  if (path === `${paths.providerMount}/token`) return 'token';
  return 'oauth';
}

function hostResponse(ctx, result) {
  let response = admissionSchema.parse(result);
  ctx.status = response.status;
  for (let [name, value] of Object.entries(response.headers ?? {})) ctx.set(name, value);
  if (response.body !== undefined) ctx.body = response.body;
}

function applyResponseHeaderDefaults(ctx, headers, excluded = new Set()) {
  for (let [name, value] of Object.entries(headers ?? {})) {
    if (!excluded.has(name.toLowerCase()) && !ctx.response.has(name))
      ctx.set(name, value);
  }
}

let providerOwnedResponseHeaders = new Set(['access-control-allow-origin']);

let admissionSchema = jsonValueSchema.pipe(z.object({
  status: z.number().int().min(200).max(599),
  body: jsonValueSchema.optional(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
}).strict());
let preparedInteractionSchema = jsonValueSchema.pipe(z.object({
  principal: jsonRecordSchema,
  token: z.string().min(1)
}).strict());
let consentDecisionSchema = jsonValueSchema.pipe(z.union([
  z.object({ authorized: z.literal(true), accountId: z.string().min(1), grantId: z.string().min(1) }).strict(),
  z.object({ authorized: z.literal(false) }).strict()
]));
let consentDetailsSchema = jsonRecordSchema;
let clientFactsSchema = jsonValueSchema.pipe(z.object({
  clientId: z.string(),
  clientName: z.string().nullable(),
  clientUri: z.string().nullable()
}).strict());

function createAuthorizationApi(provider, { origin, resource, csrfKey, grantSeconds, deleteGrantArtifacts }) {
  return Object.freeze({
    origin,
    resource,
    csrfKey,
    async findAccessToken(token) {
      token = identifierSchema.parse(token);
      let access = await provider.AccessToken.find(token);
      if (!access) return undefined;
      return accessTokenFactsSchema.parse({
        accountId: access.accountId ?? null,
        aud: access.aud ?? null,
        clientId: access.clientId ?? null,
        grantId: access.grantId ?? null,
        isExpired: access.isExpired,
        scope: access.scope ?? null
      });
    },
    async findGrant(grantId) {
      grantId = identifierSchema.parse(grantId);
      let grant = await provider.Grant.find(grantId);
      if (!grant) return undefined;
      return grantFactsSchema.parse({
        accountId: grant.accountId ?? null,
        clientId: grant.clientId ?? null,
        isExpired: grant.isExpired
      });
    },
    async allowedResourceScopes(input) {
      let { grantId, resource: requestedResource, scopes } = z.object({
        grantId: identifierSchema,
        resource: z.string().url(),
        scopes: scopeListSchema
      }).strict().parse(input);
      let grant = await provider.Grant.find(grantId);
      if (!grant || requestedResource !== resource) return [];
      return scopeListSchema.parse(
        grant.getResourceScopeFiltered(requestedResource, scopes).split(' ').filter(Boolean)
      );
    },
    async createGrant(input) {
      let { userId, clientId, scopes, requestedScopes, oidcScopes } = z.object({
        userId: identifierSchema,
        clientId: identifierSchema,
        scopes: scopeListSchema,
        requestedScopes: scopeListSchema,
        oidcScopes: scopeListSchema.default(['openid'])
      }).strict().parse(input);
      let grant = new provider.Grant({ accountId: userId, clientId });
      grant.addOIDCScope(oidcScopes.join(' '));
      grant.addResourceScope(resource, scopes.join(' '));
      grant.rejectResourceScope(
        resource,
        requestedScopes.filter(scope => !scopes.includes(scope)).join(' ')
      );
      await grant.save();
      return savedGrantSchema.parse({
        id: grant.jti,
        expiresAt: new Date((grant.exp || Math.floor(Date.now() / 1000) + grantSeconds) * 1000)
      });
    },
    async revokeGrant(grantId) {
      grantId = identifierSchema.parse(grantId);
      await provider.Grant.adapter.destroy(grantId);
      await deleteGrantArtifacts({ grantId });
    }
  });
}

/**
 * Create a Cricket-owned OIDC provider host. Provider/Koa/Node objects stay
 * inside the integration; apps provide only protocol policy and plain facts.
 */
export async function createOidcProviderHost({
  origin,
  issuer,
  resource,
  csrfKey,
  adapter,
  clients,
  jwks,
  cookieKeys,
  cookieNames,
  paths: suppliedPaths,
  browserCredentialCookie,
  accessTokenSeconds = 3600,
  grantSeconds = 2592000,
  refreshTokenSeconds = 2592000,
  requestBodyLimit = 65536,
  resourceScopes,
  scopesSupported,
  bearerMethodsSupported,
  fetchResponseBodyLimits = {
    'client_id metadata document': 5120,
    jwks_uri: 51200,
    sector_identifier_uri: 5120
  },
  fetch,
  logger,
  ...unsupportedOptions
}) {
  let paths = z.object({
    providerMount: z.string().startsWith('/').regex(/^\/[A-Za-z0-9/_-]+$/),
    resourceMetadata: z.string().startsWith('/').regex(/^\/[A-Za-z0-9/._-]+$/),
    authorizationMetadata: z.string().startsWith('/').regex(/^\/[A-Za-z0-9/._-]+$/),
    interaction: z.string().startsWith('/').regex(/^\/[A-Za-z0-9/_-]+$/),
    interactionLanding: z.string().startsWith('/').regex(/^\/[A-Za-z0-9/_-]+$/)
  }).strict().parse(suppliedPaths);
  let pathEntries = Object.entries(paths).filter(([name]) => name !== 'interactionLanding');
  let overlaps = (first, second) => first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
  for (let index = 0; index < pathEntries.length; index += 1) {
    for (let other = index + 1; other < pathEntries.length; other += 1) {
      if (overlaps(pathEntries[index][1], pathEntries[other][1]))
        throw new Error(`OIDC host paths ${pathEntries[index][0]} and ${pathEntries[other][0]} overlap`);
    }
  }
  paths = Object.freeze(paths);
  cookieNames = z.object({
    session: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    interaction: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    resume: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  }).strict().parse(cookieNames);
  if (new Set(Object.values(cookieNames)).size !== Object.keys(cookieNames).length)
    throw new Error('OIDC host cookie names must be distinct');
  cookieNames = Object.freeze(cookieNames);
  let originUrl = new URL(origin);
  if (originUrl.origin !== origin || !['http:', 'https:'].includes(originUrl.protocol))
    throw new Error('OIDC host origin must be HTTP or HTTPS without a path, query, or fragment');
  if (typeof issuer !== 'string') throw new Error('OIDC host needs an issuer URL');
  let resourceUrl = new URL(resource);
  if (resourceUrl.hash) throw new Error('OIDC resource URL must not include a fragment');
  if (!['http:', 'https:'].includes(resourceUrl.protocol))
    throw new Error('OIDC resource URL must use HTTP or HTTPS');
  let issuerUrl = new URL(issuer);
  if (issuerUrl.origin !== origin || issuerUrl.pathname !== paths.providerMount || issuerUrl.search || issuerUrl.hash)
    throw new Error('OIDC issuer must use the configured origin and provider mount path');
  if (!adapter || typeof adapter !== 'function')
    throw new Error('OIDC host needs an oidc-provider adapter factory');
  if (typeof csrfKey !== 'string' || csrfKey.length < 32)
    throw new Error('OIDC host needs a persistent CSRF key of at least 32 characters');
  if (!Array.isArray(clients) || !jwks || !Array.isArray(cookieKeys) ||
      !Array.isArray(resourceScopes) || !Array.isArray(scopesSupported) ||
      !Array.isArray(bearerMethodsSupported))
    throw new Error('OIDC host needs clients, JWKS, and persistent cookie keys');
  if (!Number.isSafeInteger(requestBodyLimit) || requestBodyLimit < 1)
    throw new Error('OIDC host requestBodyLimit must be a positive integer');
  for (let [name, seconds] of Object.entries({ accessTokenSeconds, grantSeconds, refreshTokenSeconds })) {
    if (!Number.isSafeInteger(seconds) || seconds < 1)
      throw new Error(`OIDC host ${name} must be a positive integer`);
  }
  if (Object.hasOwn(unsupportedOptions, 'trustProxy'))
    throw new Error('Configure trustProxy peers on the Cricket app, not the OIDC host');
  if (browserCredentialCookie !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(browserCredentialCookie))
    throw new Error('OIDC host browserCredentialCookie must be a cookie name');
  clients = structuredClone(z.array(jsonValueSchema).parse(clients));
  jwks = structuredClone(z.object({ keys: z.array(jsonValueSchema) }).strict().parse(jwks));
  cookieKeys = z.array(z.string().min(32)).min(1).parse(cookieKeys);
  resourceScopes = z.array(z.string().min(1)).parse(resourceScopes);
  scopesSupported = z.array(z.string().min(1)).parse(scopesSupported);
  bearerMethodsSupported = z.array(z.string().min(1)).parse(bearerMethodsSupported);
  fetchResponseBodyLimits = z.record(z.string().min(1), z.number().int().nonnegative().safe()).parse(fetchResponseBodyLimits);
  if (fetch !== undefined && typeof fetch !== 'function') throw new Error('OIDC host fetch must be a function');

  let hooks = {};
  let bound = false;
  let closed = false;
  let closing;
  let hookWork = new Set();
  let provider;

  function trackHookWork(promise) {
    let work = Promise.resolve(promise).catch(error => {
      try {
        logger?.error?.('OIDC provider observer failed', {
          name: error?.name ?? typeof error,
          code: typeof error?.code === 'string' ? error.code : null
        });
      } catch {}
    });
    hookWork.add(work);
    void work.finally(() => hookWork.delete(work));
  }

  async function drainHookWork() {
    while (hookWork.size) await Promise.all([...hookWork]);
  }

  function observeHook(callback, facts) {
    let result;
    try {
      result = callback(facts);
    } catch (error) {
      result = Promise.reject(error);
    }
    trackHookWork(result);
  }

  function closeHost() {
    if (closing) return closing;
    closed = true;
    closing = drainHookWork();
    return closing;
  }
  let settings = {
    adapter,
    clients,
    jwks,
    fetchResponseBodyLimits: { ...fetchResponseBodyLimits },
    cookies: {
      keys: [...cookieKeys],
      names: { ...cookieNames },
      short: { httpOnly: true, sameSite: 'lax', signed: true },
      long: { httpOnly: true, sameSite: 'lax', signed: true }
    },
    routes: { authorization: '/authorize', token: '/token', revocation: '/revoke', jwks: '/jwks' },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: {
        enabled: true,
        async allowedPolicy(ctx, client, token) {
          let result = jsonValueSchema.pipe(z.object({ allowed: z.boolean() }).strict()).parse(await hooks.authorizeRevocation({
            request: requestFacts(ctx, browserCredentialCookie),
            client: clientFacts(client),
            token: {
              accountId: token.accountId ?? null,
              clientId: token.clientId ?? null,
              grantId: token.grantId ?? null,
              kind: token.kind
            }
          }));
          return result.allowed;
        }
      },
      resourceIndicators: {
        enabled: true,
        defaultResource() {
          throw new errors.InvalidTarget('Specify the OIDC resource.');
        },
        getResourceServerInfo(_ctx, requestedResource) {
          if (requestedResource !== resource) throw new errors.InvalidTarget();
          return {
            audience: resource,
            scope: resourceScopes.join(' '),
            accessTokenTTL: accessTokenSeconds,
            accessTokenFormat: 'opaque'
          };
        }
      },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        async allowFetch(ctx, clientId) {
          let result = jsonValueSchema.pipe(z.object({ allowed: z.boolean() }).strict()).parse(
            await hooks.allowClientMetadata({ ip: ctx.ip, clientId })
          );
          return result.allowed;
        },
        async allowClient(_ctx, client) {
          let result = await hooks.allowClient({
            clientId: client.clientId,
            grantTypes: [...(client.grantTypes ?? [])],
            responseTypes: [...(client.responseTypes ?? [])],
            redirectUris: [...(client.redirectUris ?? [])]
          });
          return jsonValueSchema.pipe(z.object({ allowed: z.boolean() }).strict()).parse(result).allowed;
        }
      }
    },
    async revokeGrantPolicy(ctx) {
      let grantId = ctx.oidc.entities.Grant?.jti ?? ctx.oidc.entities.AccessToken?.grantId;
      let defaultRevoke = !(ctx.oidc.route === 'revocation' && ctx.oidc.entities.AccessToken);
      if (!hooks.revokeGrant) return defaultRevoke;
      let decision = jsonValueSchema.pipe(z.object({ revoke: z.boolean() }).strict()).parse(await hooks.revokeGrant({
        request: requestFacts(ctx, browserCredentialCookie),
        route: ctx.oidc.route,
        grantId: grantId ?? null,
        hasAccessToken: Boolean(ctx.oidc.entities.AccessToken)
      }));
      if (decision.revoke && grantId)
        await hooks.deleteGrantArtifacts({ grantId });
      return decision.revoke;
    },
    fetch,
    responseTypes: ['code'],
    scopes: [],
    pkce: { required: () => true, methods: ['S256'] },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    expiresWithSession: () => false,
    ttl: {
      AccessToken: accessTokenSeconds,
      AuthorizationCode: 60,
      IdToken: accessTokenSeconds,
      Grant: grantSeconds,
      Interaction: 600,
      Session: 86400,
      RefreshToken(ctx) {
        let grant = ctx.oidc.entities.Grant;
        let remaining = grant?.exp ? grant.exp - Math.floor(Date.now() / 1000) : grantSeconds;
        return Math.max(1, Math.min(refreshTokenSeconds, remaining));
      }
    },
    interactions: {
      url: (_ctx, interaction) => `${origin}${paths.interaction}/${interaction.uid}`
    },
    async loadExistingGrant(ctx) {
      let grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? await provider.Grant.find(grantId) : undefined;
    },
    async findAccount(ctx, accountId, source) {
      let requestedResource = ctx.oidc.route === 'token' ? ctx.oidc.params.resource : resource;
      if (ctx.oidc.route === 'token' && requestedResource !== resource)
        throw new errors.InvalidTarget();
      let account = await hooks.resolveAccount({
        accountId,
        grantId: ctx.oidc.route === 'token' ? source?.grantId : null,
        resource: requestedResource,
        requireGrant: ctx.oidc.route === 'token'
      });
      account = account && jsonValueSchema.pipe(z.object({ accountId: identifierSchema }).strict()).parse(account);
      return account && {
        accountId: account.accountId,
        claims: () => ({ sub: account.accountId })
      };
    }
  };

  let contextsByRequest = new WeakMap();
  let controlsByRequest = new WeakMap();
  provider = new Provider(issuer, settings);
  provider.proxy = false;
  provider.on('server_error', (_ctx, error) => {
    let facts = { name: error.name, code: error.code ?? null };
    try { logger?.error?.('OIDC provider request failed', facts); } catch {}
    if (hooks.onProviderError) observeHook(hooks.onProviderError, facts);
  });
  provider.on('grant.revoked', (_ctx, grantId) => {
    if (hooks.onGrantRevoked) observeHook(hooks.onGrantRevoked, { grantId });
  });
  provider.use(async (ctx, next) => {
    try {
      await next();
    } finally {
      applyResponseHeaderDefaults(ctx, controlsByRequest.get(ctx.req)?.responseHeaders,
        providerOwnedResponseHeaders);
    }
  });

  let koaApp = new Koa({ proxy: false });
  koaApp.keys = [...cookieKeys];
  koaApp.on('error', () => {});
  koaApp.use(async (ctx, next) => {
    try {
      await next();
    } finally {
      let controls = controlsByRequest.get(ctx.req);
      let requestPath = controls?.request.path;
      let usesProvider = requestPath === paths.providerMount ||
        requestPath?.startsWith(`${paths.providerMount}/`) ||
        requestPath === paths.authorizationMetadata;
      if (controls && !usesProvider)
        applyResponseHeaderDefaults(ctx, controls.responseHeaders);
    }
  });
  koaApp.use(async (ctx, next) => {
    let { request } = controlsByRequest.get(ctx.req);
    // Koa and the provider consume Cricket's validated transport facts. Their
    // own blanket proxy parsers stay disabled, and native headers stay intact.
    Object.defineProperties(ctx.request, {
      host: { value: request.host },
      protocol: { value: request.protocol },
      ip: { value: request.clientIp },
      clientIp: { value: request.clientIp },
      peerIp: { value: request.peerIp },
      proxyTrusted: { value: request.proxyTrusted },
      ips: { value: [] }
    });
    contextsByRequest.set(ctx.req, ctx);
    try {
      await next();
    } catch (error) {
      ctx.state.cricketProtocolError = error;
      throw error;
    }
  });
  koaApp.use(async (ctx, next) => {
    let match = interactionRoute(ctx.path, paths);
    let route = routeName(ctx.path, match, paths);
    let facts = requestFacts(ctx, browserCredentialCookie);
    let controls = controlsByRequest.get(ctx.req) ?? {};
    let continueRequest = controls.continueRequest ?? (() => {});
    let declineRequestBody = controls.declineRequestBody ?? (() => {});
    ctx.set('Cache-Control', 'no-store');
    if (closed || !bound) {
      declineRequestBody();
      ctx.status = 503;
      ctx.body = { error: closed ? 'OIDC service is shutting down.' : 'OIDC service is starting.' };
      return;
    }
    if (ctx.host !== originUrl.host) {
      declineRequestBody();
      ctx.status = 421;
      ctx.body = { error: 'Use the configured OIDC origin.' };
      return;
    }
    let admission;
    try {
      admission = await hooks.authorizeRequest({ request: facts, route });
    } catch (error) {
      declineRequestBody();
      hookError(ctx, error);
      return;
    }
    if (admission) {
      declineRequestBody();
      hostResponse(ctx, admission);
      return;
    }
    if (match) {
      let [, uid, action] = match;
      if (!/^[\w-]{10,256}$/.test(uid)) {
        declineRequestBody();
        ctx.status = 400;
        ctx.body = { error: 'Invalid connection request.' };
        return;
      }
      let allowedMethod = !action ? 'GET' : action === 'details' ? 'GET' : 'POST';
      if (ctx.method !== allowedMethod) {
        declineRequestBody();
        ctx.status = 405;
        ctx.set('Allow', allowedMethod);
        ctx.body = { error: 'Method not allowed.' };
        return;
      }
    }
    if ((ctx.path === paths.resourceMetadata || ctx.path === paths.authorizationMetadata) && ctx.method !== 'GET') {
      declineRequestBody();
      ctx.status = 405;
      ctx.set('Allow', 'GET');
      ctx.body = { error: 'Method not allowed.' };
      return;
    }
    continueRequest();
    if (ctx.path === paths.resourceMetadata) {
      ctx.body = {
        resource,
        authorization_servers: [issuer],
        scopes_supported: scopesSupported,
        bearer_methods_supported: bearerMethodsSupported
      };
      return;
    }
    if (ctx.path === paths.authorizationMetadata)
      ctx.path = `${paths.providerMount}/.well-known/oauth-authorization-server`;

    if (!match) {
      if (ctx.path === paths.providerMount || ctx.path.startsWith(`${paths.providerMount}/`)) {
        try {
          requestOutcome(await hooks.withRequest({ request: facts, route }, async () => {
            await next();
            return { status: ctx.status };
          }));
        } catch (error) {
          hookError(ctx, error);
        } finally {
          await drainHookWork();
        }
        return;
      }
      await next();
      return;
    }

    let [, uid, action] = match;
    if (!action && ctx.method === 'GET') {
      let operation = async () => {
        let details = interactionFacts(await provider.interactionDetails(ctx.req, ctx.res));
        if (details.uid !== uid) {
          ctx.status = 400;
          ctx.body = { error: 'Invalid connection request.' };
          return { status: ctx.status };
        }
        ctx.redirect(`${paths.interactionLanding}/${uid}`);
        return { status: ctx.status };
      };
      try {
        await hooks.withRequest({ request: facts, route }, operation);
      } catch (error) {
        hookError(ctx, error);
      } finally {
        await drainHookWork();
      }
      return;
    }

    if ((action === 'details' && ctx.method === 'GET') || (action === 'decision' && ctx.method === 'POST')) {
      let body;
      if (action === 'decision') {
        if (!ctx.is('application/json')) {
          ctx.status = 415;
          ctx.body = { error: 'Send a JSON request.' };
          return;
        }
        let raw;
        try {
          raw = await readRequestBody(ctx.req, { maxBytes: requestBodyLimit });
        } catch (error) {
          requestBodyError(ctx, error);
          return;
        }
        let text = raw.toString('utf8');
        try {
          body = JSON.parse(text);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        } catch {
          ctx.status = 400;
          ctx.body = { error: 'Send a valid JSON object.' };
          return;
        }
      }
      let prepared;
      try {
        prepared = preparedInteractionSchema.parse(await hooks.prepareInteraction({
          request: requestFacts(ctx, browserCredentialCookie, { includeBrowserCredential: true }),
          uid, decision: action === 'decision', body
        }));
      } catch (error) {
        hookError(ctx, error);
        return;
      }
      let operation = async () => {
        let details;
        try {
          details = interactionFacts(await provider.interactionDetails(ctx.req, ctx.res));
        } catch (error) {
          ctx.status = 400;
          ctx.body = { error: 'This authorization request has expired.', code: 'INTERACTION_EXPIRED' };
          return { status: ctx.status };
        }
        if (details.uid !== uid) {
          ctx.status = 400;
          ctx.body = { error: 'Invalid connection request.' };
          return { status: ctx.status };
        }
        let client = await provider.Client.find(details.params.client_id);
        if (!client) {
          ctx.status = 400;
          ctx.body = { error: 'The requesting client is unavailable.' };
          return { status: ctx.status };
        }
        if (action === 'details') {
          try {
            ctx.body = consentDetailsSchema.parse(await hooks.consentDetails({ request: facts, uid, interaction: details, principal: prepared.principal, token: prepared.token, client: clientFacts(client) }));
          } catch (error) {
            hookError(ctx, error);
          }
          return { status: ctx.status };
        }
        let result;
        try {
          result = consentDecisionSchema.parse(await hooks.decideConsent({ request: facts, uid, interaction: details, principal: prepared.principal, token: prepared.token, body, client: clientFacts(client) }));
        } catch (error) {
          hookError(ctx, error);
          return { status: ctx.status };
        }
        let submission = result?.authorized
          ? { login: { accountId: result.accountId }, consent: { grantId: result.grantId } }
          : { error: 'access_denied' };
        let redirectUrl = await provider.interactionResult(ctx.req, ctx.res, submission, { mergeWithLastSubmission: false });
        let resume = new URL(redirectUrl, origin);
        if (resume.origin !== origin || !resume.pathname.startsWith(`${paths.providerMount}/`)) throw new Error('Invalid OIDC resume URL');
        ctx.body = { redirectUrl: resume.href };
        return { status: ctx.status };
      };
      let outcome;
      try {
        outcome = requestOutcome(await hooks.withRequest({ request: facts, route }, operation));
      } catch (error) {
        hookError(ctx, error);
        return;
      } finally {
        await drainHookWork();
      }
      if (outcome?.status && ctx.status === 404) ctx.status = outcome.status;
      return;
    }

    ctx.status = 405;
    ctx.set('Allow', action === 'decision' ? 'POST' : 'GET');
    ctx.body = { error: 'Method not allowed.' };
  });
  koaApp.use(mount(paths.providerMount, provider));
  let handler = koaApp.callback();
  let authorization = createAuthorizationApi(provider, {
    origin,
    resource,
    csrfKey,
    grantSeconds,
    deleteGrantArtifacts: input => hooks.deleteGrantArtifacts(input)
  });
  let protocolHost = defineProtocolHost({
    name: 'oidc-provider',
    paths: {
      prefixes: [paths.providerMount, paths.interaction],
      exact: [paths.resourceMetadata, paths.authorizationMetadata]
    },
    matches(request) {
      return request.path === paths.providerMount || request.path.startsWith(`${paths.providerMount}/`) ||
        request.path === paths.resourceMetadata ||
        request.path === paths.authorizationMetadata ||
        interactionRoute(request.path, paths) !== null;
    },
    async handle({ req, res, request, responseHeaders, continueRequest, declineRequestBody }) {
      controlsByRequest.set(req, { request, responseHeaders, continueRequest, declineRequestBody });
      try {
        await handler(req, res);
      } finally {
        controlsByRequest.delete(req);
      }
      let ctx = contextsByRequest.get(req);
      if (ctx?.state.cricketProtocolError) throw ctx.state.cricketProtocolError;
    },
    close: closeHost
  });

  return Object.freeze({
    protocolHost,
    authorization,
    bind(boundHooks) {
      if (bound || closed) throw new Error('OIDC host hooks are already bound or the host is closed');
      let hooksSchema = z.object({
        authorizeRequest: z.function(),
        authorizeRevocation: z.function(),
        withRequest: z.function(),
        resolveAccount: z.function(),
        deleteGrantArtifacts: z.function(),
        prepareInteraction: z.function(),
        consentDetails: z.function(),
        decideConsent: z.function(),
        allowClientMetadata: z.function(),
        allowClient: z.function(),
        revokeGrant: z.function().optional(),
        onProviderError: z.function().optional(),
        onGrantRevoked: z.function().optional()
      });
      hooks = hooksSchema.parse(boundHooks);
      bound = true;
    }
  });
}
