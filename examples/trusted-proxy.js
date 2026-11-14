import { defineCricketApp, defineEndpoint, ok, startCricketApp } from '@robdel12/cricket';

// This example trusts a same-machine proxy. Replace these peers with verified
// deployment addresses, restrict network access, and overwrite forwarded
// host/protocol at that proxy. Never infer trust from a private network alone.
export let app = defineCricketApp({
  name: 'Trusted proxy example',
  trustProxy: { peers: ['127.0.0.1', '::1'] },
  allowedHosts: ['api.example.test'],
  domains: [{
    name: 'connection',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/connection',
      handler({ request }) {
        return ok({
          origin: request.origin,
          secure: request.secure,
          proxyTrusted: request.proxyTrusted
        });
      }
    })]
  }]
});

await startCricketApp(app, { port: 4020, main: import.meta.url });
