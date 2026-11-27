import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { fetchOAuthMetadata } from './fetch-metadata.js';

export let oauthClientAuthMethods = Object.freeze([
  'client_secret_basic',
  'client_secret_jwt',
  'client_secret_post',
  'private_key_jwt',
  'none'
]);

export let oauthClientAuthAlgorithms = Object.freeze(['HS256', 'RS256', 'PS256', 'ES256', 'Ed25519', 'EdDSA']);

let assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
let sharedSecretMethods = new Set(oauthClientAuthMethods.filter((method) => method.startsWith('client_secret_')));
let publicMetadataMethods = new Set(['none', 'private_key_jwt']);
let grantTypes = new Set(['authorization_code', 'refresh_token']);
let loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
let unsafeSchemes = new Set(['javascript:', 'vbscript:', 'data:', 'blob:', 'file:', 'about:']);
let privateKeyFields = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseUrl(value) {
  if (!isString(value) || /[\u0000-\u0020\u005c\u007f]/u.test(value) || value.includes('#')) return;
  let url = URL.parse(value);
  if (!url || url.username || url.password) return;
  // A bare "@" in the authority is discarded by new URL.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu.test(value)) return;
  return url;
}

function httpsUrl(value) {
  return parseUrl(value)?.protocol === 'https:' && /^https:\/\/[^/?#]/iu.test(value);
}

function metadataUrl(value) {
  if (!httpsUrl(value)) return false;
  let path = /^https:\/\/[^/?#]+([^?#]*)/iu.exec(value)?.[1] ?? '';
  return !path.split('/').some((segment) => /^\.{1,2}$/u.test(segment.replace(/%2e/giu, '.')));
}

function allowedRedirect(value, applicationType) {
  let url = parseUrl(value);
  if (!url) return false;
  if (applicationType === 'web') return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol === 'http:') return loopbackHosts.has(url.hostname);
  if (url.protocol === 'https:') return !loopbackHosts.has(url.hostname);
  return !unsafeSchemes.has(url.protocol);
}

function withoutLoopbackPort(value) {
  let match = /^(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::[0-9]+)?([/?].*)?$/iu.exec(value);
  return match && match[1] + (match[2] ?? '');
}

export function oauthRedirectAllowed({ redirectUris, applicationType }, candidate) {
  if (!allowedRedirect(candidate, applicationType)) return false;
  if (redirectUris.includes(candidate)) return true;
  if (applicationType !== 'native') return false;
  let loopback = withoutLoopbackPort(candidate);
  return Boolean(loopback) && redirectUris.some((uri) => withoutLoopbackPort(uri) === loopback);
}

function isPublicJwk(key) {
  return record(key) && ['RSA', 'EC', 'OKP'].includes(key.kty) &&
    privateKeyFields.every((name) => !Object.hasOwn(key, name));
}

function parseJwks(jwks) {
  if (!record(jwks) || !Array.isArray(jwks.keys) || !jwks.keys.length ||
      !jwks.keys.every(isPublicJwk)) return;
  return { keys: structuredClone(jwks.keys) };
}

function normalizeClient(input, expectedId) {
  if (!record(input) || !isString(input.client_id) || (expectedId && input.client_id !== expectedId)) return;
  if (input.dpop_bound_access_tokens === true || input.tls_client_certificate_bound_access_tokens === true)
    return;
  let applicationType = input.application_type ?? 'web';
  if (!['native', 'web'].includes(applicationType)) return;
  let redirectUris = input.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.length ||
      !redirectUris.every((uri) => allowedRedirect(uri, applicationType))) return;

  let responseTypes = input.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || !responseTypes.every(isString) ||
      !responseTypes.includes('code') || (!expectedId && responseTypes.some((type) => type !== 'code'))) return;
  let declaredGrants = input.grant_types ?? ['authorization_code'];
  if (!Array.isArray(declaredGrants) || !declaredGrants.every(isString) ||
      (!expectedId && declaredGrants.some((grant) => !grantTypes.has(grant)))) return;
  let allowedGrants = [...new Set(declaredGrants.filter((grant) => grantTypes.has(grant)))];
  if (!allowedGrants.includes('authorization_code')) return;
  if (expectedId && !allowedGrants.includes('refresh_token')) return;

  let choices = input.token_endpoint_auth_methods_supported;
  let authMethod = input.token_endpoint_auth_method;
  if (choices !== undefined) {
    if (!Array.isArray(choices) || !choices.every(isString) ||
        (authMethod !== undefined && !choices.includes(authMethod))) return;
    authMethod ??= choices.find((choice) => oauthClientAuthMethods.includes(choice) &&
      (!expectedId || publicMetadataMethods.has(choice)));
    if (!authMethod) return;
  }
  authMethod ??= 'client_secret_basic';
  if (!oauthClientAuthMethods.includes(authMethod)) return;
  if (expectedId && (!publicMetadataMethods.has(authMethod) || Object.hasOwn(input, 'client_secret') ||
      Object.hasOwn(input, 'client_secret_expires_at'))) return;
  let clientSecret = input.client_secret;
  let secretExpiresAt = input.client_secret_expires_at;
  if (sharedSecretMethods.has(authMethod) && (!isString(clientSecret) ||
      (secretExpiresAt !== undefined && (!Number.isSafeInteger(secretExpiresAt) || secretExpiresAt < 0)))) return;
  let signingAlg = input.token_endpoint_auth_signing_alg;
  let supportedAlgorithms = oauthClientAuthAlgorithms.filter((alg) => authMethod === 'client_secret_jwt'
    ? alg.startsWith('HS') : authMethod === 'private_key_jwt' && !alg.startsWith('HS'));
  if (signingAlg !== undefined && !supportedAlgorithms.includes(signingAlg)) return;
  let jwks;
  let jwksUri;
  if (authMethod === 'private_key_jwt') {
    if (input.jwks !== undefined && input.jwks_uri !== undefined) return;
    jwks = input.jwks === undefined ? undefined : parseJwks(input.jwks);
    jwksUri = httpsUrl(input.jwks_uri) ? input.jwks_uri : undefined;
    if (!jwks && !jwksUri) return;
  }

  return {
    client: Object.freeze({
      id: input.client_id,
      name: isString(input.client_name) ? input.client_name : undefined,
      uri: isString(input.client_uri) && (expectedId ? httpsUrl(input.client_uri) : parseUrl(input.client_uri))
        ? input.client_uri : undefined,
      redirectUris: Object.freeze([...redirectUris]),
      grantTypes: Object.freeze(allowedGrants),
      applicationType,
      authMethod
    }),
    credentials: {
      clientSecret, secretExpiresAt, jwks, jwksUri,
      algorithms: signingAlg ? [signingAlg] : supportedAlgorithms
    }
  };
}

function decodeBasic(value) {
  let match = /^basic ([a-z0-9+/]+={0,2})$/iu.exec(value);
  if (!match || match[1].length % 4 === 1) return;
  let bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== match[1].replace(/=+$/u, '')) return;
  try {
    let raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let separator = raw.indexOf(':');
    if (separator < 1) return;
    let id = decodeURIComponent(raw.slice(0, separator).replaceAll('+', ' '));
    let secret = decodeURIComponent(raw.slice(separator + 1).replaceAll('+', ' '));
    if (!id || !secret || /[^\x20-\x7e]/u.test(id + secret)) return;
    return { id, secret };
  } catch {}
}

function readCredentials(body, authorization) {
  if (!record(body) || [body.client_id, body.client_assertion, body.client_assertion_type, body.client_secret, authorization]
      .some((value) => value !== undefined && !isString(value))) return;
  if ([authorization, body.client_assertion, body.client_secret].filter(Boolean).length > 1 ||
      Boolean(body.client_assertion) !== Boolean(body.client_assertion_type)) return;

  if (authorization) {
    let parsed = decodeBasic(authorization);
    if (!parsed || (body.client_id && parsed.id !== body.client_id)) return;
    return parsed;
  }
  if (body.client_assertion) {
    if (body.client_assertion_type !== assertionType) return;
    try {
      let claims = decodeJwt(body.client_assertion);
      if (!isString(claims.sub) || (body.client_id && claims.sub !== body.client_id)) return;
      return { id: claims.sub, assertion: body.client_assertion };
    } catch {
      return;
    }
  }
  if (!body.client_id) return;
  return { id: body.client_id, secret: body.client_secret };
}

function sameSecret(left, right) {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest()
  );
}

/** Resolve configured and metadata-document OAuth clients and verify their credentials. */
export function createOAuthClients({
  clients = [],
  issuer,
  tokenEndpoint = `${issuer}/token`,
  fetchMetadata = fetchOAuthMetadata,
  allowClientMetadata,
  recordAssertion,
  clock = () => Date.now()
}) {
  let configured = new Map();
  let fetched = new Map();
  for (let input of clients) {
    let entry = normalizeClient(input);
    if (!entry || configured.has(entry.client.id)) throw new Error('Invalid or duplicate OAuth client configuration');
    configured.set(entry.client.id, entry);
  }

  async function metadata(url, kind, request) {
    try {
      // The transport enforces the deadline, public IPs, status and size before parsing.
      return await fetchMetadata(url, { kind, maxBytes: kind === 'jwks' ? 51200 : 5120, request, signal: request?.signal });
    } catch {
      return;
    }
  }

  async function findEntry(id, request) {
    if (configured.has(id)) return configured.get(id);
    if (!metadataUrl(id)) return;
    let cached = fetched.get(id);
    let now = clock();
    if (cached && cached.expiresAt > now) return cached.entry;
    if (allowClientMetadata && (await allowClientMetadata({ clientId: id, request })) !== true) return;
    let document = await metadata(id, 'client', request);
    let entry = normalizeClient(document, id);
    if (!entry) return;
    if (fetched.size >= 100 && !fetched.has(id)) fetched.delete(fetched.keys().next().value);
    fetched.set(id, { entry, expiresAt: now + 30_000 });
    return entry;
  }

  async function find(id, request) {
    return (await findEntry(id, request))?.client;
  }

  async function authenticate({ body, authorization, endpoint, request }) {
    let input = readCredentials(body, authorization);
    if (!input) return;
    let entry = await findEntry(input.id, request);
    if (!entry) return;
    let { client, credentials } = entry;
    if (client.authMethod === 'none') return input.secret || input.assertion ? undefined : client;

    let now = Math.floor(clock() / 1000);
    if (credentials.secretExpiresAt && credentials.secretExpiresAt <= now) return;
    if (client.authMethod === 'client_secret_basic' || client.authMethod === 'client_secret_post') {
      if (input.secret && sameSecret(credentials.clientSecret, input.secret)) return client;
      return;
    }
    if (!input.assertion || typeof recordAssertion !== 'function') return;

    let allowedAudiences = [...new Set([issuer, tokenEndpoint, endpoint])];
    let key;
    if (client.authMethod === 'client_secret_jwt') {
      key = Buffer.from(credentials.clientSecret);
    } else {
      let jwks = credentials.jwks ?? parseJwks(await metadata(credentials.jwksUri, 'jwks', request));
      if (!jwks) return;
      key = createLocalJWKSet(jwks);
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(input.assertion, key, {
        algorithms: credentials.algorithms,
        issuer: input.id,
        subject: input.id,
        audience: allowedAudiences,
        requiredClaims: ['exp', 'jti'],
        clockTolerance: 15,
        currentDate: new Date(now * 1000)
      }));
    } catch {
      return;
    }
    if (!isString(payload.jti) || (payload.iat !== undefined && payload.iat > now + 15)) return;
    let seconds = Math.ceil(payload.exp + 15 - now);
    if (seconds <= 0 || seconds > 615) return;
    if (await recordAssertion({ issuer, clientId: input.id, jti: payload.jti, seconds }) === true)
      return client;
  }

  return Object.freeze({ find, authenticate });
}
