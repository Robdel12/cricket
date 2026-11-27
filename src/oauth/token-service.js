import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { grantResourceScopes } from './authorization-service.js';

let pkceVerifier = /^[a-zA-Z0-9._~-]{43,128}$/;
let pkceChallenge = /^[a-zA-Z0-9_-]{43}$/;

function validPkce(verifier, challenge, method) {
  if (method !== 'S256' || !pkceVerifier.test(verifier) || !pkceChallenge.test(challenge))
    return false;
  let actual = createHash('sha256').update(verifier).digest('base64url');
  return timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}

function scopeList(scope) {
  return typeof scope === 'string' ? [...new Set(scope.split(' ').filter(Boolean))] : [];
}

function isActive(record, now) {
  return Number.isSafeInteger(record?.exp) && record.exp > now;
}

function rejected(error) {
  return { error };
}

/**
 * Execute OAuth grant exchanges using the application's durable token store.
 *
 * The store owns locking and must run each operation in the same transaction.
 * Its reads return immutable facts, and must retain the consumed marker until
 * the credential expires so that a second use can revoke the affected grant.
 */
export function createOAuthTokenService({
  store,
  resolveAccount,
  resource,
  accessTokenSeconds,
  refreshTokenSeconds,
  clock = () => Date.now(),
  generateId = () => randomBytes(32).toString('base64url')
}) {
  function nowSeconds() {
    return Math.floor(clock() / 1000);
  }

  async function mint(tx, { grant, source, scope, now, grantType, issueRefreshToken }) {
    let accessId = generateId();
    let expiresIn = Math.min(accessTokenSeconds, grant.exp - now);
    let accessToken = {
      kind: 'AccessToken',
      jti: accessId,
      iat: now,
      exp: now + expiresIn,
      accountId: grant.accountId,
      clientId: grant.clientId,
      grantId: source.grantId,
      gty: grantType === 'authorization_code' ? grantType : 'authorization_code refresh_token',
      aud: resource,
      scope,
      sessionUid: source.sessionUid
    };
    await tx.save('AccessToken', accessToken);
    let refreshId;
    if (issueRefreshToken) {
      refreshId = generateId();
      await tx.save('RefreshToken', {
        kind: 'RefreshToken',
        jti: refreshId,
        iat: now,
        exp: Math.min(now + refreshTokenSeconds, grant.exp),
        accountId: grant.accountId,
        clientId: grant.clientId,
        grantId: source.grantId,
        gty: grantType === 'authorization_code' ? grantType : 'authorization_code refresh_token',
        scope: source.scope,
        resource,
        sessionUid: source.sessionUid,
        authTime: source.authTime ?? now,
        iiat: source.iiat ?? now,
        rotations: grantType === 'authorization_code' ? 0 : (source.rotations ?? 0) + 1
      });
    }
    return {
      access_token: accessId,
      token_type: 'Bearer',
      expires_in: expiresIn,
      ...(refreshId ? { refresh_token: refreshId } : {}),
      scope
    };
  }

  async function exchange({ clientId, grantType, credential, requestedResource, scope, verifier, redirectUri, issueRefreshToken }) {
    if (requestedResource !== resource) return rejected('invalid_target');
    if (!credential || !clientId) return rejected('invalid_request');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
      return rejected('unsupported_grant_type');
    let codeExchange = grantType === 'authorization_code';
    let kind = codeExchange ? 'AuthorizationCode' : 'RefreshToken';
    return await store.transaction(async (tx) => {
      let now = nowSeconds();
      let source = await tx.read(kind, credential);
      if (source?.jkt || source?.dpopJkt || source?.['x5t#S256'] || source?.attestationJkt)
        return rejected('invalid_grant');
      if (!isActive(source, now) || source.clientId !== clientId || !source.grantId)
        return rejected('invalid_grant');
      if (source.resource !== resource &&
        !(Array.isArray(source.resource) && source.resource.length === 1 && source.resource[0] === resource))
        return rejected('invalid_target');
      if (codeExchange &&
        (redirectUri !== source.redirectUri || !validPkce(verifier, source.codeChallenge, source.codeChallengeMethod)))
        return rejected('invalid_grant');

      let grant = await tx.read('Grant', source.grantId);
      if (!isActive(grant, now) || grant.clientId !== clientId || grant.accountId !== source.accountId)
        return rejected('invalid_grant');
      let approved = grantResourceScopes(grant, resource);
      let allowed = scopeList(source.scope).filter((name) => approved.includes(name));
      let requested = codeExchange || scope === undefined ? allowed : scopeList(scope);
      if (!requested.length || requested.some((name) => !allowed.includes(name)))
        return rejected('invalid_scope');
      let account = await resolveAccount({
        accountId: grant.accountId,
        grantId: source.grantId,
        resource,
        requireGrant: true
      });
      if (account?.accountId !== grant.accountId) return rejected('invalid_grant');
      if (source.consumed != null) {
        await tx.revokeGrant(source.grantId);
        return rejected('invalid_grant');
      }

      await tx.consume(kind, credential);
      return await mint(tx, { grant, source, scope: requested.join(' '), now, grantType, issueRefreshToken });
    });
  }

  async function revoke({ clientId, credential, tokenTypeHint }) {
    return await store.transaction(async (tx) => {
      let order = tokenTypeHint === 'refresh_token'
        ? ['RefreshToken', 'AccessToken']
        : ['AccessToken', 'RefreshToken'];
      for (let kind of order) {
        let token = await tx.read(kind, credential);
        if (token?.clientId !== clientId || !isActive(token, nowSeconds())) continue;
        if (kind === 'AccessToken') await tx.remove(kind, credential);
        else if (token.grantId) await tx.revokeGrant(token.grantId);
        break;
      }
    });
  }

  return Object.freeze({ exchange, revoke });
}
