import { defineEndpoint } from '../endpoint.js';
import { respond, withError } from '../response.js';
import { createOAuthRequestRule, oauthResponse } from './request-rule.js';

let jwtBearer = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
let tokenForm = 'application/x-www-form-urlencoded';

function oauthError(error, status = 400, headers = {}) {
  return oauthResponse(respond(status, { error }), headers);
}

function tokenFormFrom(request) {
  let contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' ||
    contentType.split(';')[0].trim().toLowerCase() !== tokenForm)
    return undefined;
  let values = new URLSearchParams(request.rawBody);
  let body = Object.create(null);
  for (let [name, value] of values) {
    if (Object.hasOwn(body, name)) return undefined;
    body[name] = value;
  }
  return Object.freeze(body);
}

function tokenInput(body) {
  let { grant_type: grantType } = body;
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
    return { error: grantType ? 'unsupported_grant_type' : 'invalid_request' };
  let isCode = grantType === 'authorization_code';
  let credential = isCode ? body.code : body.refresh_token;
  if (!credential || (isCode && !body.code_verifier))
    return { error: 'invalid_request' };
  return {
    grantType,
    credential,
    verifier: body.code_verifier,
    redirectUri: body.redirect_uri,
    requestedResource: body.resource,
    scope: body.scope
  };
}

function createTokenEndpoint(path, isRevocation, serviceName) {
  let route = isRevocation ? 'revocation' : 'token';
  return defineEndpoint({
    method: 'post',
    path,
    summary: isRevocation ? 'Revoke an OAuth credential' : 'Exchange an OAuth credential',
    tags: ['OAuth'],
    maxBodyBytes: 64 * 1024,
    rawBody: true,
    beforeBodyRules: [createOAuthRequestRule(serviceName, route)],
    async handler({ request, oauth }) {
      try {
        let body = tokenFormFrom(request);
        if (!body) return oauthError('invalid_request');
        if (request.headers.dpop) return oauthError('invalid_dpop_proof');
        if (body.client_assertion_type && body.client_assertion_type !== jwtBearer)
          return oauthError('invalid_client');

        let authorization = request.headers.authorization;
        let input = isRevocation ? { credential: body.token } : tokenInput(body);
        if (input.error || !input.credential)
          return oauthError(input.error ?? 'invalid_request');
        let client = await oauth.clients.authenticate({
          body,
          authorization,
          endpoint: oauth.origin + path,
          request
        });
        if (!client) {
          let challenge = authorization ? { 'WWW-Authenticate': 'Basic realm="oauth"' } : {};
          return oauthError('invalid_client', authorization ? 401 : 400, challenge);
        }
        if (isRevocation) {
          await oauth.tokens.revoke({
            clientId: client.id,
            credential: input.credential,
            tokenTypeHint: body.token_type_hint
          });
          return oauthResponse(respond(200));
        }
        if (!client.grantTypes.includes(input.grantType)) return oauthError('unauthorized_client');
        let redirectUri = input.redirectUri;
        if (redirectUri === undefined && client.redirectUris.length === 1)
          redirectUri = client.redirectUris[0];
        if (input.grantType === 'authorization_code' && !redirectUri)
          return oauthError('invalid_request');
        let result = await oauth.tokens.exchange({
          ...input,
          redirectUri,
          clientId: client.id,
          issueRefreshToken: client.grantTypes.includes('refresh_token')
        });
        return result.error ? oauthError(result.error) : oauthResponse(respond(200, result));
      } catch (error) {
        return withError(oauthError('server_error', 503), error);
      }
    }
  });
}

export function createOAuthTokenEndpoints({ token, revocation }, serviceName) {
  return Object.freeze([createTokenEndpoint(token, false, serviceName), createTokenEndpoint(revocation, true, serviceName)]);
}
