import { respond, withError, withHeaders } from '../response.js';
import { defineRule } from '../rule.js';

let securityHeaders = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer'
});
let loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function oauthResponse(response, headers) {
  return withHeaders(response, { ...headers, ...securityHeaders });
}

export function createOAuthRequestRule(serviceName, route) {
  return defineRule('admitOAuthRequest', async ({ request, services }) => {
    let oauth = services[serviceName];
    if (!oauth) return oauthResponse(respond(404, { error: 'not_found' }));
    let origin = URL.parse(oauth.origin);
    if (!origin || origin.origin !== oauth.origin ||
        (origin.protocol !== 'https:' &&
          !(origin.protocol === 'http:' && loopbackHosts.has(origin.hostname))))
      return withError(oauthResponse(respond(503, { error: 'server_error' })),
        new Error('OAuth needs a public HTTPS origin or a loopback HTTP origin'));
    if (request.host.toLowerCase() !== origin.host ||
        `${request.protocol}:` !== origin.protocol)
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
