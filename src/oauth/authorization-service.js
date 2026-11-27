import { randomBytes } from 'node:crypto';

function listScopes(value) {
  return typeof value === 'string' ? [...new Set(value.split(' ').filter(Boolean))] : [];
}

export function grantResourceScopes(grant, resource) {
  let rejected = new Set(listScopes(grant.rejected?.resources?.[resource]));
  return listScopes(grant.resources?.[resource]).filter((scope) => !rejected.has(scope));
}

/** Create app-facing OAuth grant and access-token operations for a transactional store. */
export function createOAuthAuthorization({
  origin,
  resource,
  csrfKey,
  grantSeconds,
  store,
  clock = () => Date.now(),
  generateId = () => randomBytes(32).toString('base64url')
}) {
  let nowSeconds = () => Math.floor(clock() / 1000);

  function active(row) {
    return Number.isSafeInteger(row?.exp) && row.exp > nowSeconds();
  }

  return Object.freeze({
    origin,
    resource,
    csrfKey,
    async findAccessToken(id) {
      return await store.transaction(async (tx) => {
        let access = await tx.read('AccessToken', id);
        if (!active(access) || access.jkt || access['x5t#S256']) return undefined;
        let { accountId, aud, clientId, grantId, scope } = access;
        return Object.freeze({ accountId, aud, clientId, grantId, scope, isExpired: false });
      });
    },
    async findGrant(id) {
      return await store.transaction(async (tx) => {
        let grant = await tx.read('Grant', id);
        if (!active(grant)) return undefined;
        let { accountId, clientId } = grant;
        return Object.freeze({ accountId, clientId, isExpired: false });
      });
    },
    async allowedResourceScopes({ grantId, resource: requestedResource, scopes }) {
      if (requestedResource !== resource) return [];
      return await store.transaction(async (tx) => {
        let grant = await tx.read('Grant', grantId);
        if (!active(grant)) return [];
        let granted = grantResourceScopes(grant, resource);
        return Object.freeze(scopes.filter((scope) => granted.includes(scope)));
      });
    },
    async createGrant({ userId, clientId, scopes, requestedScopes }) {
      if (!scopes.length || scopes.some((scope) => !requestedScopes.includes(scope)))
        throw new Error('Cannot grant scopes that the client did not request');
      let iat = nowSeconds();
      let exp = iat + grantSeconds;
      let id = generateId();
      let rejected = [...new Set(requestedScopes)].filter((scope) => !scopes.includes(scope));
      let row = {
        kind: 'Grant',
        jti: id,
        iat,
        exp,
        accountId: userId,
        clientId,
        resources: { [resource]: [...new Set(scopes)].join(' ') },
        openid: { scope: 'openid' },
        ...(rejected.length > 0
          ? { rejected: { resources: { [resource]: rejected.join(' ') } } }
          : {})
      };
      await store.transaction((tx) => tx.save('Grant', row));
      return Object.freeze({ id, expiresAt: new Date(exp * 1000) });
    },
    async revokeGrant(id) {
      await store.transaction((tx) => tx.revokeGrant(id));
    }
  });
}
