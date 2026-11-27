import { respond, withError, withHeaders } from '../response.js';
import { defineRule } from '../rule.js';

let securityHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer'
});

export function oauthResponse(response, headers) {
  return withHeaders(response, { ...headers, ...securityHeaders });
}

export function createOAuthRequestRule(serviceName, route) {
  return defineRule('admitOAuthRequest', async ({ request, services }) => {
    let oauth = services[serviceName];
    if (!oauth) return oauthResponse(respond(404, { error: 'not_found' }));
    if (request.host.toLowerCase() !== new URL(oauth.origin).host)
      return oauthResponse(respond(421, { error: 'invalid_request' }));
    try {
      let admission = await oauth.authorizeRequest?.({ request, route });
      if (admission)
        return oauthResponse(respond(admission.status, admission.body), admission.headers);
      return { oauth };
    } catch (error) {
      return withError(oauthResponse(respond(503, { error: 'server_error' })), error);
    }
  });
}
