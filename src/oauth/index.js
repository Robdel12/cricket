import { defineCricketPlugin } from '../plugin.js';
import { createOAuthInteractionEndpoints } from './interaction.routes.js';
import { createOAuthMetadataEndpoints } from './metadata.routes.js';
import { createOAuthTokenEndpoints } from './token.routes.js';

export { createOAuthAuthorization } from './authorization-service.js';
export { createOAuthClients } from './clients.js';
export { fetchOAuthMetadata } from './fetch-metadata.js';
export { publicOAuthKeys } from './metadata.routes.js';
export { createOAuthTokenService } from './token-service.js';

/**
 * @guide oauth Host OAuth for MCP
 * Use Cricket's OAuth plugin to let an MCP client connect to your API through
 * your app's sign-in and consent flow.
 *
 * Import `defineOAuthPlugin` from `@robdel12/cricket/oauth` and add
 * `defineOAuthPlugin({ paths, serviceName: 'oauth' })` to the app's `plugins`.
 * Set the plugin's `paths` for authorization, token exchange, revocation,
 * JWKS, authorization discovery, resource discovery, and the browser
 * interaction and consent page. Compose the `oauth` service with the public
 * origin, issuer, resource, and app hooks when the
 * app sets up its dependencies and domain services.
 *
 * Cricket serves authorization code with S256 PKCE and resource-bound opaque
 * tokens. The app decides who can sign in, what a user can consent to, and how
 * to check the user's current access. Use `createOAuthClients` for configured
 * clients and Client ID Metadata Documents, and `fetchOAuthMetadata` for
 * bounded requests to public HTTPS metadata.
 *
 * The app supplies a durable store to `createOAuthAuthorization` and
 * `createOAuthTokenService`. Run each store operation inside one database
 * transaction. Lock the grant and credential before consuming a code or
 * refresh token. Commit the consumed credential and its replacements together.
 * Keep the consumed marker until the credential expires so replay can revoke
 * the affected grant.
 *
 * Test the browser consent and token flow over HTTP with your database. Cover
 * concurrent redemption, rejected exchanges, refresh rotation, and revocation.
 * Verify that revoking a connection leaves other connections working.
 */

/**
 * Define an opt-in OAuth domain for MCP authorization and token exchange.
 * @param {{paths: object, serviceName?: string}} options - Public route paths and the app service name.
 */
export function defineOAuthPlugin({ paths, serviceName = 'oauth' }) {
  let pathNames = [
    'authorization', 'token', 'revocation', 'jwks', 'authorizationMetadata',
    'resourceMetadata', 'interaction', 'interactionLanding'
  ];
  if (!paths || pathNames.some((name) =>
    typeof paths[name] !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_/.~-]+$/.test(paths[name])
  )) throw new Error('OAuth routes need absolute paths without parameters, queries, or fragments.');
  if (typeof serviceName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(serviceName))
    throw new Error('OAuth needs a valid Cricket service name.');
  paths = Object.freeze({ ...paths });
  return defineCricketPlugin({
    name: 'oauth',
    domains: [{
      name: 'oauth',
      endpoints: [
        ...createOAuthMetadataEndpoints(paths, serviceName),
        ...createOAuthInteractionEndpoints({ paths, serviceName }),
        ...createOAuthTokenEndpoints(paths, serviceName)
      ]
    }]
  });
}
