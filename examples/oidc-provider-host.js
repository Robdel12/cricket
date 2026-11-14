import { createOidcProviderHost } from '@robdel12/cricket/oidc-provider';

/**
 * Create the host during app setup. `adapter`, client configuration, and the
 * safe remote-metadata fetch function remain owned by the application.
 */
export async function createExampleOidcSetup({
  origin,
  adapter,
  clients,
  jwks,
  cookieKeys,
  csrfKey,
  fetchOAuthMetadata
}) {
  let host = await createOidcProviderHost({
    origin,
    issuer: `${origin}/oauth`,
    resource: `${origin}/mcp`,
    csrfKey,
    adapter,
    clients,
    jwks,
    cookieKeys,
    cookieNames: {
      session: 'example_oauth_session',
      interaction: 'example_oauth_interaction',
      resume: 'example_oauth_resume'
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
    protocolHosts: [host.protocolHost],
    dependencies: { oidcHost: host }
  };
}

/**
 * Call from `defineCricketApp({ services })`, after `services` includes the
 * app's domain services and before the runtime begins accepting requests.
 */
export function bindExampleOidcPolicy(host, oauthServices) {
  host.bind({
    authorizeRequest: facts => oauthServices.authorizeRequest(facts),
    authorizeRevocation: facts => oauthServices.authorizeRevocation(facts),
    withRequest: (facts, run) => oauthServices.withProtocolRequest(facts, run),
    resolveAccount: facts => oauthServices.resolveAccount(facts),
    deleteGrantArtifacts: facts => oauthServices.deleteGrantArtifacts(facts),
    prepareInteraction: facts => oauthServices.prepareInteraction(facts),
    consentDetails: facts => oauthServices.consentDetails(facts),
    decideConsent: facts => oauthServices.decideConsent(facts),
    allowClientMetadata: facts => oauthServices.allowClientMetadata(facts),
    allowClient: facts => oauthServices.allowClient(facts)
  });
}
