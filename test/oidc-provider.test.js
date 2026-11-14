import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createMemoryAdapter } from 'oidc-provider/lib/adapters/memory_adapter.js';
import { createCricketRuntime, defineEndpoint, respond, withHeaders } from '../src/index.js';
import { createOidcProviderHost } from '../src/oidc-provider.js';
import { defineManualTestApp } from '../test-support/app.js';

let keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
let privateKey = { ...keyPair.privateKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };

let paths = {
  providerMount: '/oauth',
  resourceMetadata: '/.well-known/oauth-protected-resource/mcp',
  authorizationMetadata: '/.well-known/oauth-authorization-server/oauth',
  interaction: '/api/oauth-interactions',
  interactionLanding: '/authorize'
};

async function startHost(overrides = {}, hookOverrides = {}, {
  cricketServer = false,
  afterCreate,
  trustProxy = false,
  appOptions = {}
} = {}) {
  let runtime;
  let oidcHost;
  let seenInteractions = [];
  let server;
  let port;
  let origin;
  if (cricketServer) {
    let reservation = http.createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    origin = `http://127.0.0.1:${port}`;
  } else {
    server = http.createServer((req, res) => runtime.handle(req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
  }
  let app = defineManualTestApp({
    ...appOptions,
    trustProxy,
    async setup() {
      let clients = overrides.clients ?? [{
        client_id: 'test-client',
        client_secret: 'test-secret',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        redirect_uris: [`${origin}/callback`],
        token_endpoint_auth_method: 'client_secret_basic'
      }];
      let jwks = overrides.jwks ?? { keys: [structuredClone(privateKey)] };
      let host = await createOidcProviderHost({

        origin,
        issuer: `${origin}/oauth`,
        resource: `${origin}/mcp`,
        csrfKey: 'c'.repeat(48),
        adapter: createMemoryAdapter(),
        clients,
        jwks,
        cookieKeys: ['k'.repeat(48)],
        cookieNames: { session: 'oidc_session', interaction: 'oidc_interaction', resume: 'oidc_resume' },
        paths,
        resourceScopes: ['read'],
        scopesSupported: ['read'],
        bearerMethodsSupported: ['header'],
        ...overrides,
        clients,
        jwks
      });
      afterCreate?.({ clients, jwks });
      oidcHost = host;
      host.bind({
        async authorizeRequest() { return undefined; },
        async authorizeRevocation() { return { allowed: true }; },
        async withRequest(_facts, run) { return await run(); },
        async resolveAccount({ accountId }) { return { accountId }; },
        async deleteGrantArtifacts() {},
        async prepareInteraction() { return { principal: { userId: 'user-1' }, token: 'session-token' }; },
        async consentDetails({ interaction }) { seenInteractions.push(interaction); return { client: 'test-client', scopes: ['read'] }; },
        async decideConsent() {
          let grant = await host.authorization.createGrant({
            userId: 'user-1', clientId: 'test-client', scopes: ['read'], requestedScopes: ['read']
          });
          return { authorized: true, accountId: 'user-1', grantId: grant.id };
        },
        async allowClientMetadata() { return { allowed: false }; },
        async allowClient() { return { allowed: true }; },
        ...hookOverrides
      });
      return { protocolHosts: [host.protocolHost] };
    }
  });
  try {
    runtime = await createCricketRuntime(app, { logger() {} });
    if (cricketServer) {
      server = runtime.app.listen(port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    return {
      origin,
      runtime,
      oidcHost,
      authorization: oidcHost.authorization,
      seenInteractions,
      async close() {
        await runtime.cleanup();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    };
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

async function request(origin, path, options = {}) {
  return fetch(path.startsWith('http') ? path : `${origin}${path}`, { redirect: 'manual', ...options });
}

function updateCookies(cookie, response) {
  let values = new Map((cookie ? cookie.split(/;\s*/) : []).map(value => {
    let [name, ...parts] = value.split('=');
    return [name, parts.join('=')];
  }));
  for (let header of response.headers.getSetCookie()) {
    let [pair, ...attributes] = header.split(';');
    let [name, ...rest] = pair.split('=');
    if (attributes.some(attribute => /^\s*Max-Age=0\s*$/i.test(attribute))) values.delete(name);
    else values.set(name, rest.join('='));
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

describe('Cricket OIDC provider host', () => {
  it('uses validated HTTPS and client IP through a trusted HTTP proxy, including secure provider cookies', async () => {
    let seen = [];
    let publicOrigin = 'https://auth.example.test';
    let host = await startHost({
      origin: publicOrigin, issuer: `${publicOrigin}/oauth`, resource: `${publicOrigin}/mcp`,
      clients: [{ client_id: 'proxy-client', client_secret: 'secret',
        grant_types: ['authorization_code'], response_types: ['code'],
        redirect_uris: [`${publicOrigin}/callback`], token_endpoint_auth_method: 'client_secret_basic' }]
    }, {
      authorizeRequest({ request }) { seen.push(request); }
    }, { trustProxy: { peers: ['127.0.0.0/8', '10.0.0.0/8'] } });
    let headers = { 'x-forwarded-host': 'auth.example.test', 'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.99, 198.51.100.7, 10.1.2.3',
      'x-real-ip': '192.0.2.99' };
    try {
      let metadata = await request(host.origin, paths.authorizationMetadata, { headers });
      assert.equal(metadata.status, 200);
      assert.equal((await metadata.json()).issuer, `${publicOrigin}/oauth`);
      let params = new URLSearchParams({ client_id: 'proxy-client', response_type: 'code',
        redirect_uri: `${publicOrigin}/callback`, scope: 'openid read', resource: `${publicOrigin}/mcp`,
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
      let response = await request(host.origin, `/oauth/authorize?${params}`, { headers });
      assert.equal(response.status, 303, await response.text());
      assert.equal(new URL(response.headers.get('location')).origin, publicOrigin);
      let cookies = response.headers.getSetCookie();
      assert.ok(cookies.some(cookie => cookie.startsWith('oidc_interaction=')));
      assert.ok(cookies.every(cookie => /; secure(?:;|$)/i.test(cookie)), cookies.join('\n'));
      assert.equal(seen.length, 2);
      assert.ok(seen.every(facts => facts.host === 'auth.example.test' && facts.ip === '198.51.100.7'));
      assert.ok(seen.every(facts => facts.clientIp === facts.ip && facts.peerIp === '127.0.0.1' &&
        facts.proxyTrusted === true && facts.protocol === 'https' && facts.secure === true));
    } finally {
      await host.close();
    }
  });

  it('ignores untrusted OIDC authority and IP spoofing before protocol admission', async () => {
    let seen;
    let host = await startHost({}, {
      authorizeRequest({ request }) { seen = request; }
    }, { trustProxy: { peers: ['192.0.2.0/24'] } });
    try {
      let response = await request(host.origin, paths.authorizationMetadata, { headers: {
        'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https',
        'x-forwarded-for': 'invalid', 'x-real-ip': '192.0.2.1'
      } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).issuer, `${host.origin}/oauth`);
      assert.equal(seen.host, new URL(host.origin).host);
      assert.equal(seen.ip, '127.0.0.1');
      assert.equal(seen.clientIp, seen.peerIp);
      assert.equal(seen.proxyTrusted, false);
      assert.equal(seen.protocol, 'http');
      assert.equal(seen.secure, false);
    } finally {
      await host.close();
    }
  });

  it('rejects the removed OIDC-local blanket proxy option', async () => {
    await assert.rejects(startHost({ trustProxy: true }), /Configure trustProxy peers on the Cricket app/);
  });

  it('serves resource and authorization metadata through Cricket HTTP admission', async () => {
    let host = await startHost();
    try {
      let resource = await request(host.origin, paths.resourceMetadata);
      assert.equal(resource.status, 200);
      assert.deepEqual(await resource.json(), {
        resource: `${host.origin}/mcp`,
        authorization_servers: [`${host.origin}/oauth`],
        scopes_supported: ['read'],
        bearer_methods_supported: ['header']
      });
      let authorization = await request(host.origin, paths.authorizationMetadata);
      assert.equal(authorization.status, 200);
      let metadata = await authorization.json();
      assert.equal(metadata.issuer, `${host.origin}/oauth`);
      assert.equal(metadata.token_endpoint, `${host.origin}/oauth/token`);
    } finally {
      await host.close();
    }
  });

  it('applies app response headers and preflight policy to OIDC protocol responses', async () => {
    let host = await startHost({}, {
      authorizeRequest({ route }) {
        if (route === 'interaction_details')
          return { status: 401, body: { error: 'Sign in required.' } };
      }
    }, {
      appOptions: {
        responseHeaders(request) {
          let headers = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'X-Request-Path': request.path,
            'Access-Control-Allow-Origin': 'https://default.example.test'
          };
          return headers;
        },
        requestPolicy({ request }) {
          if (request.method === 'OPTIONS' && request.path.startsWith('/.well-known/'))
            return withHeaders(respond(204), {
              'Access-Control-Allow-Origin': request.headers.origin,
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
              Vary: 'Origin'
            });
        }
      }
    });
    try {
      let resource = await request(host.origin, paths.resourceMetadata, {
        headers: { origin: 'https://client.example.test' }
      });
      assert.equal(resource.status, 200);
      assert.equal(resource.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(resource.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(resource.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(resource.headers.get('x-request-path'), paths.resourceMetadata);
      assert.equal(resource.headers.get('access-control-allow-origin'), 'https://default.example.test');

      let authorization = await request(host.origin, paths.authorizationMetadata, {
        headers: { origin: host.origin }
      });
      assert.equal(authorization.status, 200);
      assert.equal(authorization.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(authorization.headers.get('access-control-allow-origin'), host.origin,
        'the provider’s explicit origin header overrides app defaults');

      let providerCors = await request(host.origin, '/oauth/token', {
        method: 'POST',
        headers: {
          origin: 'https://untrusted.example.test',
          authorization: `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=invalid'
      });
      assert.equal(providerCors.status, 400);
      assert.equal(providerCors.headers.get('access-control-allow-origin'), null,
        'a provider-owned CORS denial is not replaced by the app default');

      let denied = await request(host.origin, `${paths.interaction}/0123456789abcdef/details`, {
        headers: { origin: 'https://client.example.test' }
      });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');

      let preflight = await request(host.origin, paths.resourceMetadata, {
        method: 'OPTIONS',
        headers: { origin: 'https://client.example.test', 'access-control-request-method': 'GET' }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://client.example.test');
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    } finally {
      await host.close();
    }
  });

  it('keeps host paths exclusive and closes setup hosts when startup rejects them', async () => {
    let rejectedHost;
    await assert.rejects(createCricketRuntime(defineManualTestApp({
      async setup() {
        let host = await createOidcProviderHost({
          origin: 'https://example.test', issuer: 'https://example.test/oauth',
          resource: 'https://example.test/mcp', csrfKey: 'c'.repeat(48),
          adapter: createMemoryAdapter(), clients: [], jwks: { keys: [] },
          cookieKeys: ['k'.repeat(48)],
          cookieNames: { session: 's', interaction: 'i', resume: 'r' },
          paths,
          resourceScopes: [], scopesSupported: [], bearerMethodsSupported: []
        });
        rejectedHost = host;
        return { protocolHosts: [host.protocolHost, host.protocolHost] };
      }
    })), /duplicate host name/);
    assert.throws(() => rejectedHost.bind({}), /closed/);
  });


  it('rejects endpoint paths that overlap a protocol host and closes the rejected host', async () => {
    let rejectedHost;
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/oauth/:token',
      handler() { return {}; }
    });
    await assert.rejects(createCricketRuntime(defineManualTestApp({
      endpoints: [endpoint],
      async setup() {
        rejectedHost = await createOidcProviderHost({
          origin: 'https://example.test', issuer: 'https://example.test/oauth',
          resource: 'https://example.test/mcp', csrfKey: 'c'.repeat(48),
          adapter: createMemoryAdapter(), clients: [], jwks: { keys: [] },
          cookieKeys: ['k'.repeat(48)],
          cookieNames: { session: 's', interaction: 'i', resume: 'r' },
          paths,
          resourceScopes: [], scopesSupported: [], bearerMethodsSupported: []
        });
        return { protocolHosts: [rejectedHost.protocolHost] };
      }
    }), { logger() {} }), /overlaps endpoint route GET \/oauth\/:token/);
    assert.throws(() => rejectedHost.bind({}), /closed/);
  });

  it('completes authorization code with S256 PKCE, consent, Basic token auth, refresh and revocation', async () => {
    let observerStartedResolve;
    let observerReleaseResolve;
    let observerStarted = new Promise(resolve => { observerStartedResolve = resolve; });
    let observerRelease = new Promise(resolve => { observerReleaseResolve = resolve; });
    let callerConfig;
    let host = await startHost({}, {
      async onGrantRevoked({ grantId }) {
        observerStartedResolve(grantId);
        await observerRelease;
      }
    }, {
      afterCreate(input) { callerConfig = input; }
    });
    callerConfig.clients[0].client_secret = 'caller-mutated';
    callerConfig.clients[0].redirect_uris[0] = 'https://attacker.test/callback';
    callerConfig.jwks.keys[0].d = 'caller-mutated';
    assert.equal(Object.isFrozen(callerConfig.clients), false);
    assert.equal(Object.isFrozen(callerConfig.clients[0]), false);
    assert.equal(Object.isFrozen(callerConfig.jwks.keys[0]), false);
    try {
      let verifier = 'a'.repeat(43);
      let digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      let challenge = Buffer.from(digest).toString('base64url');
      let authorize = new URL('/oauth/authorize', host.origin);
      authorize.search = new URLSearchParams({
        client_id: 'test-client', response_type: 'code', redirect_uri: `${host.origin}/callback`,
        scope: 'openid read', resource: `${host.origin}/mcp`, state: 'opaque-state',
        code_challenge: challenge, code_challenge_method: 'S256'
      });
      let first = await request(host.origin, authorize.pathname + authorize.search);
      assert.equal(first.status, 303);
      let cookie = updateCookies('', first);
      let current = new URL(first.headers.get('location'));
      let callback;
      let interactions = 0;
      while (!callback?.searchParams.has('code') && interactions < 4) {
        assert.equal(current.origin, host.origin);
        assert.equal(current.pathname.startsWith(paths.interaction), true);
        let details = await request(host.origin, `${current.pathname}/details`, { headers: { cookie } });
        assert.equal(details.status, 200);
        cookie = updateCookies(cookie, details);
        assert.deepEqual(await details.json(), { client: 'test-client', scopes: ['read'] });
        let decision = await request(host.origin, `${current.pathname}/decision`, {
          method: 'POST',
          headers: { cookie, origin: host.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ csrfToken: 'test' })
        });
        let decisionText = await decision.text();
        assert.equal(decision.status, 200, decisionText);
        cookie = updateCookies(cookie, decision);
        let resume = await request(host.origin, JSON.parse(decisionText).redirectUrl, { headers: { cookie } });
        assert.equal(resume.status, 303);
        cookie = updateCookies(cookie, resume);
        current = new URL(resume.headers.get('location'));
        interactions += 1;
        if (current.pathname.startsWith(`${paths.interaction}/`)) continue;
        callback = current;
      }
      assert.ok(callback, JSON.stringify(host.seenInteractions));
      assert.deepEqual(host.seenInteractions.map(interaction => interaction.prompt.name), ['login']);
      assert.equal(callback.origin, host.origin);
      assert.equal(callback.searchParams.get('state'), 'opaque-state', callback.href);
      assert.ok(callback.searchParams.get('code'));
      let credentials = Buffer.from('test-client:test-secret').toString('base64');
      let token = await request(host.origin, '/oauth/token', {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: callback.searchParams.get('code'),
          redirect_uri: `${host.origin}/callback`, code_verifier: verifier,
          resource: `${host.origin}/mcp`
        })
      });
      let tokenText = await token.text();
      assert.equal(token.status, 200, tokenText);
      let tokens = JSON.parse(tokenText);
      let accessFacts = await host.authorization.findAccessToken(tokens.access_token);
      assert.equal(accessFacts.aud, `${host.origin}/mcp`);
      assert.equal(accessFacts.clientId, 'test-client');
      assert.equal(accessFacts.isExpired, false);
      assert.equal(Object.getPrototypeOf(accessFacts), Object.prototype);
      let grantFacts = await host.authorization.findGrant(accessFacts.grantId);
      assert.equal(grantFacts.accountId, 'user-1');
      assert.equal(grantFacts.isExpired, false);
      assert.deepEqual(await host.authorization.allowedResourceScopes({
        grantId: accessFacts.grantId, resource: `${host.origin}/mcp`, scopes: ['read']
      }), ['read']);
      await assert.rejects(host.authorization.findAccessToken(new String(tokens.access_token)));
      assert.equal(tokens.token_type, 'Bearer');
      assert.equal(tokens.scope, 'read');
      let refreshed = await request(host.origin, '/oauth/token', {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: `${host.origin}/mcp` })
      });
      assert.equal(refreshed.status, 200);
      let rotated = await refreshed.json();
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);
      let revocation = request(host.origin, '/oauth/revoke', {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rotated.refresh_token, token_type_hint: 'refresh_token' })
      });
      let grantId = await observerStarted;
      assert.ok(grantId);
      let closed = false;
      let closing = host.runtime.cleanup().then(() => { closed = true; });
      await Promise.resolve();
      assert.equal(closed, false, 'host close must wait for accepted observer work');
      observerReleaseResolve();
      let revoked = await revocation;
      assert.equal(revoked.status, 200);
      await closing;
      assert.equal(closed, true);
      await host.runtime.cleanup();
      assert.throws(() => host.oidcHost.bind({}), /already bound or the host is closed/);
    } finally {
      observerReleaseResolve?.();
      await host.close();
    }
  });

  it('bounds interaction request bodies and keeps errors in flat public envelopes', async () => {
    let host = await startHost({ requestBodyLimit: 8 });
    try {
      let oversized = await request(host.origin, `${paths.interaction}/0123456789abcdef/decision`, {
        method: 'POST',
        headers: { origin: host.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ consent: true })
      });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), { error: 'Request is too large.' });
      let unsupported = await request(host.origin, `${paths.interaction}/0123456789abcdef/details`, {
        method: 'POST'
      });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get('allow'), 'GET');
    } finally {
      await host.close();
    }
  });

  it('routes unsupported Expect headers through shared Cricket HTTP checks before OIDC', async () => {
    let runtime = await createCricketRuntime(defineManualTestApp({
      async setup() {
        let oidc = await createOidcProviderHost({
          origin: 'http://127.0.0.1:1', issuer: 'http://127.0.0.1:1/oauth',
          resource: 'http://127.0.0.1:1/mcp', csrfKey: 'c'.repeat(48),
          adapter: createMemoryAdapter(), clients: [], jwks: { keys: [] },
          cookieKeys: ['k'.repeat(48)],
          cookieNames: { session: 's', interaction: 'i', resume: 'r' },
          paths,
          resourceScopes: [], scopesSupported: [], bearerMethodsSupported: []
        });
        oidc.bind({
          authorizeRequest() { throw new Error('OIDC host should not receive unsupported Expect'); },
          authorizeRevocation() { return { allowed: false }; },
          withRequest(_facts, run) { return run(); }, resolveAccount() {}, deleteGrantArtifacts() {},
          prepareInteraction() {}, consentDetails() {}, decideConsent() {},
          allowClientMetadata() { return { allowed: false }; }, allowClient() { return { allowed: false }; }
        });
        return { protocolHosts: [oidc.protocolHost] };
      }
    }), { logger() {} });
    let server = runtime.app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      let response = await new Promise((resolve, reject) => {
        let req = http.request({
          host: '127.0.0.1',
          port: server.address().port,
          path: '/oauth/token',
          method: 'POST',
          headers: { expect: 'something-else' }
        }, resolve);
        req.once('error', reject);
        req.end();
      });
      let body = '';
      for await (let chunk of response) body += chunk;
      assert.equal(response.statusCode, 417);
      assert.match(body, /EXPECTATION_FAILED/);
    } finally {
      await runtime.cleanup();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });


  it('sends Continue only after admission and rejects an Expect request without its body', async () => {
    let accepted = await startHost({}, {}, { cricketServer: true });
    try {
      let continued = false;
      let response = await new Promise((resolve, reject) => {
        let req = http.request({
          host: '127.0.0.1', port: new URL(accepted.origin).port,
          path: '/oauth/token', method: 'POST',
          headers: { expect: '100-continue', 'content-type': 'application/x-www-form-urlencoded' }
        }, resolve);
        req.once('error', reject);
        req.once('continue', () => {
          continued = true;
          req.end('grant_type=invalid');
        });
        req.flushHeaders();
      });
      let body = '';
      for await (let chunk of response) body += chunk;
      assert.equal(continued, true);
      assert.ok(response.statusCode >= 400, body);
    } finally {
      await accepted.close();
    }

    let denied = await startHost({}, {
      authorizeRequest({ route }) {
        return route === 'token' ? { status: 429, body: { error: 'Try again later.' } } : undefined;
      }
    }, { cricketServer: true });
    try {
      let continued = false;
      let response = await new Promise((resolve, reject) => {
        let req = http.request({
          host: '127.0.0.1', port: new URL(denied.origin).port,
          path: '/oauth/token', method: 'POST',
          headers: { expect: '100-continue', 'content-type': 'application/x-www-form-urlencoded' }
        }, resolve);
        req.once('error', reject);
        req.once('continue', () => {
          continued = true;
          req.destroy(new Error('Denied request must not ask the client to upload its body'));
        });
        req.flushHeaders();
      });
      let body = '';
      for await (let chunk of response) body += chunk;
      assert.equal(continued, false);
      assert.equal(response.statusCode, 429);
      assert.deepEqual(JSON.parse(body), { error: 'Try again later.' });
    } finally {
      await denied.close();
    }
  });


  it('keeps a disconnected protocol request in Cricket drain until its hook work settles', async () => {
    let enteredResolve;
    let releaseResolve;
    let entered = new Promise(resolve => { enteredResolve = resolve; });
    let release = new Promise(resolve => { releaseResolve = resolve; });
    let host = await startHost({}, {
      async authorizeRequest({ route }) {
        if (route === 'token') {
          enteredResolve();
          await release;
        }
      }
    });
    try {
      let req = http.request({
        host: '127.0.0.1', port: new URL(host.origin).port,
        path: '/oauth/token', method: 'GET'
      });
      let clientClosed = new Promise(resolve => req.once('close', resolve));
      req.once('error', () => {});
      req.end();
      await entered;
      req.destroy();
      await clientClosed;
      let cleanupFinished = false;
      let cleanup = host.runtime.cleanup().then(() => { cleanupFinished = true; });
      await Promise.resolve();
      assert.equal(cleanupFinished, false);
      releaseResolve();
      await cleanup;
      assert.equal(cleanupFinished, true);
    } finally {
      releaseResolve();
      await host.close();
    }
  });

});
