import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { defineEndpoint } from '../endpoint.js';
import { ok, redirect, respond, withCookies, withError, withHeaders } from '../response.js';
import { grantResourceScopes } from './authorization-service.js';
import { oauthRedirectAllowed } from './clients.js';
import { createOAuthRequestRule, oauthResponse } from './request-rule.js';

let idPattern = /^[a-zA-Z0-9_-]{10,256}$/;
let challengePattern = /^[a-zA-Z0-9_-]{43}$/;
let unsupportedParameters = Object.freeze([
  'request', 'request_uri', 'authorization_details', 'dpop_jkt', 'code_challenge_media_type'
]);
export let oauthResponseModes = Object.freeze(['query', 'fragment', 'form_post']);
let authorizeParameters = Object.freeze([
  'client_id', 'redirect_uri', 'response_type', 'resource', 'scope', 'state', 'prompt',
  'response_mode', 'code_challenge', 'code_challenge_method'
]);

function readScope(scope) {
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
}

function protocolError(error, description, status = 400) {
  return respond(status, { error, error_description: description });
}

function expiredInteraction() {
  return respond(400, { error: 'This authorization request has expired.', code: 'INTERACTION_EXPIRED' });
}

function html(value) {
  let escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (character) => escapes[character]);
}

function callbackResponse({ redirect_uri, state, response_mode }, issuer, fields) {
  let target = new URL(redirect_uri);
  for (let name of ['code', 'error', 'error_description', 'state', 'iss'])
    target.searchParams.delete(name);
  let values = {
    ...fields,
    iss: issuer,
    ...(state === undefined ? {} : { state })
  };
  if (response_mode === 'fragment') {
    target.hash = new URLSearchParams(values).toString();
  } else if (response_mode === 'form_post') {
    let nonce = randomBytes(18).toString('base64url');
    let inputs = Object.entries(values).map(([name, value]) =>
      `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join('');
    return withHeaders(respond(200,
      `<!doctype html><html lang="en"><title>Continue authorization</title><body>` +
      `<form method="post" action="${html(target.href)}">${inputs}<button>Continue</button></form>` +
      `<script nonce="${nonce}">document.forms[0].submit()</script></body></html>`
    ), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${target.origin}; base-uri 'none'; frame-ancestors 'none'`
    });
  } else {
    for (let [name, value] of Object.entries(values)) target.searchParams.set(name, value);
  }
  return redirect(target.href, 303);
}

function responseModeAllowed({ response_mode, redirect_uri }) {
  if (response_mode === undefined || response_mode === 'query' || response_mode === 'fragment')
    return true;
  return response_mode === 'form_post' && ['https:', 'http:'].includes(new URL(redirect_uri).protocol);
}

function nowSeconds(oauth) {
  return Math.floor((oauth.clock ?? Date.now)() / 1000);
}

function issueId() {
  return randomBytes(32).toString('base64url');
}

// Existing clients may finish an already-started request across a deploy or rollback.
// These cookie names, paths and the HMAC wire format are shared by both releases.
function cookieSignature(name, id, key) {
  return createHmac('sha1', key).update(`${name}=${id}`).digest('base64url');
}

function cookiePair(oauth, name, id, path, maxAge) {
  let options = { path, httpOnly: true, sameSite: 'lax', secure: oauth.origin.startsWith('https:'),
    maxAge };
  return [
    { name, value: maxAge ? id : '', options },
    { name: `${name}.sig`, value: maxAge ? cookieSignature(name, id, oauth.cookieKeys[0]) : '', options }
  ];
}

function hasSignedCookie(oauth, request, name, id) {
  let sig = request.cookies?.[`${name}.sig`];
  if (request.cookies?.[name] !== id || typeof sig !== 'string' || !/^[a-zA-Z0-9_-]{27}$/.test(sig))
    return false;
  let value = Buffer.from(sig);
  return oauth.cookieKeys.some(key =>
    timingSafeEqual(value, Buffer.from(cookieSignature(name, id, key))));
}

function clientFacts(client) {
  return Object.freeze({
    clientId: client.id ?? client.clientId,
    clientName: client.name ?? client.clientName ?? null,
    clientUri: client.uri ?? client.clientUri ?? null
  });
}

function invalidInteraction() {
  return respond(400, { error: 'Invalid connection request.' });
}

function parseAuthorizationQuery(query, oauth) {
  for (let name of authorizeParameters) {
    let value = query[name];
    if (value !== undefined && (typeof value !== 'string' || value.length > 4096))
      return protocolError('invalid_request', 'OAuth parameters must each have one value.');
  }
  if (!query.client_id)
    return protocolError('invalid_request', 'Specify the client ID.');
  return Object.freeze({
    client_id: query.client_id,
    redirect_uri: query.redirect_uri,
    response_type: query.response_type,
    resource: query.resource,
    scope: query.scope ?? oauth.scopesSupported?.[0] ?? oauth.resourceScopes[0],
    state: query.state,
    prompt: query.prompt,
    response_mode: query.response_mode,
    code_challenge: query.code_challenge,
    code_challenge_method: query.code_challenge_method,
    unsupported: unsupportedParameters.some(name => query[name] !== undefined)
  });
}

function authorizationError(params, oauth) {
  if (params.response_type !== 'code')
    return { error: 'unsupported_response_type', error_description: 'Use response_type=code.' };
  if (params.unsupported)
    return { error: 'invalid_request', error_description: 'Unsupported authorization parameters.' };
  if (!challengePattern.test(params.code_challenge ?? '') || params.code_challenge_method !== 'S256')
    return { error: 'invalid_request', error_description: 'An S256 PKCE challenge is required.' };
  if (params.resource !== oauth.resource)
    return { error: 'invalid_target', error_description: 'Specify the configured resource.' };
  let scopes = readScope(params.scope);
  if (!scopes.length || scopes.some(scope => !oauth.resourceScopes.includes(scope)))
    return { error: 'invalid_scope', error_description: 'One or more requested scopes are unavailable.' };
  let prompts = readScope(params.prompt);
  if (prompts.includes('none') && prompts.length > 1)
    return { error: 'invalid_request', error_description: 'Use prompt=none on its own.' };
  if (prompts.includes('none')) return { error: 'interaction_required' };
  return null;
}

async function startAuthorization({ oauth, request, paths }) {
  let query = parseAuthorizationQuery(request.query ?? {}, oauth);
  if (!Object.hasOwn(query, 'client_id')) return query;
  let client = await oauth.resolveClient({ clientId: query.client_id, request });
  if (!client)
    return protocolError('invalid_client', 'The requesting client is unavailable.', 401);
  let redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1
    ? client.redirectUris[0]
    : undefined);
  if (!redirectUri || !oauthRedirectAllowed(client, redirectUri))
    return protocolError('invalid_request', 'The redirect URI is invalid.');
  let authorization = { ...query, redirect_uri: redirectUri };
  if (!responseModeAllowed(authorization))
    return protocolError('invalid_request', 'The requested response mode is unavailable.');
  let failed = authorizationError(authorization, oauth);
  if (failed) {
    // A public metadata document does not authorize navigating the user's browser.
    if (client.fromMetadata) return protocolError(failed.error, failed.error_description);
    return callbackResponse(authorization, oauth.issuer, failed);
  }

  let uid = issueId();
  let iat = nowSeconds(oauth);
  let interactionPath = `${paths.interaction}/${uid}`;
  let resumePath = `${paths.authorization}/${uid}`;
  let interactionSeconds = oauth.interactionSeconds ?? 600;
  let params = Object.fromEntries(Object.entries(authorization).filter(([name, value]) =>
    value !== undefined && name !== 'unsupported'));
  let row = {
    jti: uid, kind: 'Interaction', iat, exp: iat + interactionSeconds, params,
    returnTo: new URL(resumePath, oauth.origin).href, trusted: [], cid: issueId(),
    prompt: { name: 'login', reasons: [], details: {} }
  };
  await oauth.store.transaction(async tx => await tx.save('Interaction', row));
  return withCookies(redirect(new URL(interactionPath, oauth.origin).href), [
    ...cookiePair(oauth, oauth.cookieNames.interaction, uid, interactionPath, interactionSeconds),
    ...cookiePair(oauth, oauth.cookieNames.resume, uid, resumePath, interactionSeconds)
  ]);
}

function hookInteraction(row) {
  return Object.freeze({
    uid: row.jti,
    params: Object.freeze({ ...row.params }),
    prompt: row.prompt,
    result: row.result ?? null
  });
}

async function validInteraction(oauth, tx, uid) {
  let row = await tx.read('Interaction', uid);
  if (row?.kind !== 'Interaction' || row.jti !== uid || !Number.isSafeInteger(row.exp) ||
      row.exp <= nowSeconds(oauth) || !row.params) return null;
  if (row.session?.uid) {
    let session = await tx.readSession(row.session.uid);
    if (!session || session.accountId !== row.session.accountId ||
        !Number.isSafeInteger(session.exp) || session.exp <= nowSeconds(oauth)) return null;
  }
  return row;
}

async function landing({ oauth, request, paths }) {
  let uid = request.params.uid;
  if (!idPattern.test(uid) || !hasSignedCookie(oauth, request, oauth.cookieNames.interaction, uid))
    return invalidInteraction();
  let exists = await oauth.store.transaction(async tx => await validInteraction(oauth, tx, uid));
  if (!exists) return expiredInteraction();
  return redirect(`${paths.interactionLanding}/${uid}`, 302);
}

function decisionBody(request) {
  let contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json')
    return { rejection: respond(415, { error: 'Send a JSON request.' }) };
  try {
    let body = JSON.parse(request.rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return { rejection: respond(400, { error: 'Send a valid JSON object.' }) };
    return { body };
  } catch {
    return { rejection: respond(400, { error: 'Send a valid JSON object.' }) };
  }
}

async function interaction({ oauth, request, decision, paths }) {
  let uid = request.params.uid;
  if (!idPattern.test(uid)) return invalidInteraction();
  if (!hasSignedCookie(oauth, request, oauth.cookieNames.interaction, uid))
    return expiredInteraction();
  if (decision && request.headers.origin !== oauth.origin)
    return respond(403, { error: 'This request must come from Vizzly.', code: 'INVALID_ORIGIN' });
  let { body, rejection } = decision ? decisionBody(request) : {};
  if (rejection) return rejection;
  let { principal, token } = await oauth.prepareInteraction({ request, uid, decision, body });

  return await oauth.store.transaction(async tx => {
    let row = await validInteraction(oauth, tx, uid);
    if (!row) return expiredInteraction();
    if (decision && row.result)
      return respond(409, { error: 'This connection request has already been answered.',
        code: 'INTERACTION_COMPLETED' });
    if (row.session?.accountId && row.session.accountId !== principal.userId)
      return expiredInteraction();
    let client = await oauth.resolveClient({ request, clientId: row.params.client_id });
    if (!client)
      return respond(400, { error: 'The requesting client is unavailable.' });
    if (!oauthRedirectAllowed(client, row.params.redirect_uri))
      return protocolError('invalid_request', 'The redirect URI is invalid.');
    let input = { request, uid, interaction: hookInteraction(row), principal, token,
      client: clientFacts(client) };
    if (!decision) return ok(await oauth.consentDetails(input));

    let given = await oauth.decideConsent({ ...input, body });
    let result = given.authorized
      ? { login: { accountId: given.accountId }, consent: { grantId: given.grantId } }
      : { error: 'access_denied' };
    await tx.save('Interaction', { ...row, result });
    return ok({ redirectUrl: new URL(`${paths.authorization}/${uid}`, oauth.origin).href });
  });
}

function allowedGrantScope(grant, params, resource) {
  let requested = new Set(readScope(params.scope));
  return grantResourceScopes(grant, resource).filter(scope => requested.has(scope)).join(' ');
}

async function resumeAuthorization({ oauth, request, paths }) {
  let uid = request.params.uid;
  if (!idPattern.test(uid) || !hasSignedCookie(oauth, request, oauth.cookieNames.resume, uid))
    return expiredInteraction();
  return await oauth.store.transaction(async tx => {
    let row = await validInteraction(oauth, tx, uid);
    if (!row || !row.result) return expiredInteraction();
    let session = row.session;
    if (session?.uid && !hasSignedCookie(oauth, request, oauth.cookieNames.session, session.cookie))
      return expiredInteraction();
    let params = row.params;
    let client = await oauth.resolveClient({ request, clientId: params.client_id });
    if (!client || !oauthRedirectAllowed(client, params.redirect_uri))
      return protocolError('invalid_request', 'The redirect URI is invalid.');
    if (!responseModeAllowed(params))
      return protocolError('invalid_request', 'The requested response mode is unavailable.');
    let finished;
    if (row.result.error) {
      finished = callbackResponse(params, oauth.issuer, { error: 'access_denied' });
    } else {
      let grantId = row.result.consent?.grantId;
      let accountId = row.result.login?.accountId;
      let iat = nowSeconds(oauth);
      let grant = grantId && await tx.read('Grant', grantId);
      let target = Array.isArray(params.resource) && params.resource.length === 1
        ? params.resource[0] : params.resource;
      if (!grant || !Number.isSafeInteger(grant.exp) || grant.exp <= iat || grant.accountId !== accountId ||
          grant.clientId !== params.client_id || target !== oauth.resource ||
          params.dpop_jkt !== undefined || params.request_uri !== undefined ||
          params.authorization_details !== undefined ||
          !challengePattern.test(params.code_challenge ?? '') ||
          params.code_challenge_method !== 'S256') {
        return protocolError('invalid_grant', 'This authorization is no longer valid.');
      }
      let scope = allowedGrantScope(grant, params, oauth.resource);
      if (!scope) return protocolError('invalid_grant', 'This authorization has no valid scopes.');
      let jti = issueId();
      await tx.save('AuthorizationCode', {
        jti, kind: 'AuthorizationCode', iat, exp: iat + (oauth.authorizationCodeSeconds ?? 60),
        authTime: iat, accountId, grantId, clientId: params.client_id,
        codeChallenge: params.code_challenge, codeChallengeMethod: params.code_challenge_method,
        redirectUri: params.redirect_uri, resource: oauth.resource, scope
      });
      finished = callbackResponse(params, oauth.issuer, { code: jti });
    }
    await tx.remove('Interaction', uid);
    return withCookies(finished, cookiePair(oauth, oauth.cookieNames.resume, uid,
      `${paths.authorization}/${uid}`, 0));
  });
}

function interactionEndpoint({ path, method, operationId, admitAs, handler, rawBody, serviceName }) {
  return defineEndpoint({
    path, method, operationId,
    ...(rawBody ? { rawBody: true, maxBodyBytes: 65536 } : {}),
    beforeBodyRules: [createOAuthRequestRule(serviceName, admitAs)],
    async handler({ oauth, request }) {
      try {
        return oauthResponse(await handler({ oauth, request }));
      } catch (error) {
        let status = error?.status ?? error?.statusCode;
        if (Number.isInteger(status) && status >= 400 && status < 500)
          return oauthResponse(respond(status, {
            error: error.message,
            ...(typeof error.code === 'string' ? { code: error.code } : {})
          }));
        return oauthResponse(withError(respond(503, { error: 'Authorization is temporarily unavailable.' }), error));
      }
    }
  });
}

export function createOAuthInteractionEndpoints({ paths, serviceName }) {
  return Object.freeze([
    interactionEndpoint({
      serviceName,
      method: 'get', path: paths.authorization,
      operationId: 'beginOAuthAuthorization', admitAs: 'authorization',
      handler: input => startAuthorization({ ...input, paths })
    }),
    interactionEndpoint({
      serviceName,
      method: 'get', path: `${paths.authorization}/:uid`,
      operationId: 'finishOAuthAuthorization', admitAs: 'resume',
      handler: input => resumeAuthorization({ ...input, paths })
    }),
    interactionEndpoint({
      serviceName,
      method: 'get', path: `${paths.interaction}/:uid`,
      operationId: 'redirectToOAuthConsent', admitAs: 'interaction',
      handler: input => landing({ ...input, paths })
    }),
    interactionEndpoint({
      serviceName,
      method: 'get', path: `${paths.interaction}/:uid/details`,
      operationId: 'getOAuthConsentDetails', admitAs: 'interaction_details',
      handler: input => interaction({ ...input, paths, decision: false })
    }),
    interactionEndpoint({
      serviceName,
      method: 'post', path: `${paths.interaction}/:uid/decision`, rawBody: true,
      operationId: 'decideOAuthConsent', admitAs: 'interaction_decision',
      handler: input => interaction({ ...input, paths, decision: true })
    })
  ]);
}
