import { createPrivateKey, createPublicKey } from 'node:crypto';
import { defineEndpoint } from '../endpoint.js';
import { ok } from '../response.js';
import { oauthClientAuthAlgorithms, oauthClientAuthMethods } from './clients.js';
import { oauthResponseModes } from './interaction.routes.js';
import { createOAuthRequestRule, oauthResponse } from './request-rule.js';

/** Export public keys from app-owned OAuth signing keys for the discovery endpoint. */
export function publicOAuthKeys(jwks) {
  return Object.freeze({
    keys: Object.freeze(jwks.keys.map((key) => {
      let publicKey = createPublicKey(createPrivateKey({ key, format: 'jwk' }));
      return Object.freeze({
        ...publicKey.export({ format: 'jwk' }),
        kid: key.kid,
        ...(key.alg ? { alg: key.alg } : {}),
        ...(key.use ? { use: key.use } : {})
      });
    }))
  });
}

function metadataEndpoint(path, serviceName, summary, render) {
  return defineEndpoint({
    method: 'get',
    path,
    summary,
    tags: ['OAuth'],
    beforeBodyRules: [createOAuthRequestRule(serviceName, 'metadata')],
    handler({ oauth }) {
      return oauthResponse(ok(render(oauth)));
    }
  });
}

export function createOAuthMetadataEndpoints(paths, serviceName) {
  function authorizationMetadata(oauth) {
    return {
      issuer: oauth.issuer,
      authorization_endpoint: oauth.origin + paths.authorization,
      token_endpoint: oauth.origin + paths.token,
      revocation_endpoint: oauth.origin + paths.revocation,
      jwks_uri: oauth.origin + paths.jwks,
      response_types_supported: ['code'],
      response_modes_supported: oauthResponseModes,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: oauthClientAuthMethods,
      token_endpoint_auth_signing_alg_values_supported: oauthClientAuthAlgorithms,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true
    };
  }
  return Object.freeze([
    metadataEndpoint(paths.authorizationMetadata, serviceName, 'Discover OAuth authorization', authorizationMetadata),
    metadataEndpoint(paths.resourceMetadata, serviceName, 'Discover authorization for the protected resource', (oauth) => ({
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      scopes_supported: oauth.scopesSupported,
      bearer_methods_supported: ['header']
    })),
    metadataEndpoint(paths.jwks, serviceName, 'Read OAuth public keys', (oauth) => oauth.publicKeys)
  ]);
}
