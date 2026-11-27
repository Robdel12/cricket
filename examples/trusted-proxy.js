import { defineCricketApp, defineEndpoint, ok, startCricketApp } from '@robdel12/cricket';

// This trusts a proxy on the same machine. Swap in your real proxy addresses,
// and have the proxy overwrite forwarded headers. Being on a private network
// isn't enough to trust a caller.
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
