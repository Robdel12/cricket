import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

import { createCricketRuntime, defineCricketApp, defineEndpoint, ok } from '../src/index.js';
import { createHttpApp, rawHttpResponse } from './fixtures/http.js';

async function proxyApp(trustProxy) {
  return await createHttpApp({
    trustProxy,
    endpoints: [defineEndpoint({
      method: 'get', path: '/facts',
      handler: ({ request: facts }) => ok({
        peerIp: facts.peerIp, clientIp: facts.clientIp, proxyTrusted: facts.proxyTrusted,
        host: facts.host, protocol: facts.protocol, origin: facts.origin, secure: facts.secure
      })
    })]
  });
}

let loopback = { peers: ['127.0.0.0/8', '::1'] };

describe('explicit trusted proxy peers', () => {
  it('rejects blanket trust, malformed peers, and mutable replacement contracts', () => {
    for (let trustProxy of [true, 1, null, {}, { peers: [] }, { peers: ['localhost'] },
      { peers: ['10.0.0.1/33'] }, { peers: ['::1/129'] }, { peers: ['::1/'] },
      { peers: ['fe80::1%lo0'] }, { peers: ['127.0.0.1'], hops: 1 }]) {
      assert.throws(() => defineCricketApp({ domains: [], trustProxy }), /trustProxy/);
    }
    let peers = ['127.0.0.1'];
    let app = defineCricketApp({ domains: [], trustProxy: { peers } });
    peers[0] = '192.0.2.1';
    assert.deepEqual(app.trustProxy.peers, ['127.0.0.1']);
    assert.ok(Object.isFrozen(app.trustProxy));
    assert.ok(Object.isFrozen(app.trustProxy.peers));
  });

  it('rejects composed contracts that replace the validated trust policy', async () => {
    let app = defineCricketApp({ domains: [], trustProxy: loopback });
    await assert.rejects(createCricketRuntime({ ...app, trustProxy: true }), /cannot replace trustProxy/);
  });

  for (let trustProxy of [false, { peers: ['192.0.2.0/24'] }]) {
    it(`ignores spoofed and malformed forwarding from an untrusted socket (${JSON.stringify(trustProxy)})`, async () => {
      let response = await request(await proxyApp(trustProxy)).get('/facts')
        .set('Host', 'direct.test').set('X-Forwarded-Host', 'evil.test, other.test')
        .set('X-Forwarded-Proto', 'invalid').set('X-Forwarded-For', 'garbage')
        .set('X-Real-IP', '198.51.100.90').set('Forwarded', 'for=198.51.100.91;proto=https');
      assert.equal(response.status, 200);
      assert.equal(response.body.proxyTrusted, false);
      assert.equal(response.body.peerIp, '127.0.0.1');
      assert.equal(response.body.clientIp, '127.0.0.1');
      assert.equal(response.body.origin, 'http://direct.test');
    });
  }

  it('uses trusted authority facts and stops at the nearest untrusted forwarding hop', async () => {
    let app = await proxyApp({ peers: [...loopback.peers, '10.0.0.0/8', '2001:db8:1::/48'] });
    let response = await request(app).get('/facts').set('Host', 'internal.test')
      .set('X-Forwarded-Host', 'api.example.test:443').set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', '203.0.113.99, 198.51.100.8, 2001:db8:1::7, 10.2.3.4');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      peerIp: '127.0.0.1', clientIp: '198.51.100.8', proxyTrusted: true,
      host: 'api.example.test:443', protocol: 'https', origin: 'https://api.example.test:443', secure: true
    });
  });

  it('combines repeated physical XFF headers in wire order and normalizes mapped IPv6', async () => {
    let app = await proxyApp({ peers: ['::ffff:7f00:0/104', '::ffff:a00:0/104'] });
    let response = await rawHttpResponse(app,
      'GET /facts HTTP/1.1\r\nHost: direct.test\r\n' +
      'X-Forwarded-For: ::ffff:cb00:7163, 0:0:0:0:0:ffff:c633:6408\r\n' +
      'X-Forwarded-For: ::ffff:a01:203\r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 200/);
    assert.match(response, /"peerIp":"127.0.0.1"/);
    assert.match(response, /"clientIp":"198.51.100.8"/);
    assert.match(response, /"proxyTrusted":true/);
  });

  for (let [peer, expected] of [['::ffff:7f00:1', true], ['::ffff:7f00:2', false]]) {
    it(`matches exact mapped IPv6 peer ${peer} against the actual IPv4 socket`, async () => {
      let config = { peers: [peer] };
      let app = await proxyApp(config);
      config.peers[0] = expected ? '192.0.2.1' : '127.0.0.1';
      let response = await request(app).get('/facts').set('X-Forwarded-For', '198.51.100.8');
      assert.equal(response.status, 200);
      assert.equal(response.body.peerIp, '127.0.0.1');
      assert.equal(response.body.proxyTrusted, expected);
      assert.equal(response.body.clientIp, expected ? '198.51.100.8' : '127.0.0.1');
    });
  }

  it('uses the actual native IPv6 peer for CIDR trust', async () => {
    let app = await proxyApp({ peers: ['0:0:0:0:0:0:0:1/128'] });
    let server = app.listen(0, '::1');
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      let response = await fetch(`http://[::1]:${server.address().port}/facts`, {
        headers: { 'x-forwarded-for': '2001:db8:2::9' }
      });
      assert.equal(response.status, 200);
      let facts = await response.json();
      assert.equal(facts.peerIp, '::1');
      assert.equal(facts.clientIp, '2001:db8:2::9');
      assert.equal(facts.proxyTrusted, true);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('uses canonical IPv6 clients and falls back to direct authority when headers are absent', async () => {
    let response = await request(await proxyApp(loopback)).get('/facts').set('Host', 'direct.test')
      .set('X-Forwarded-For', '2001:0db8:0002:0000:0000:0000:0000:0001');
    assert.equal(response.status, 200);
    assert.equal(response.body.clientIp, '2001:db8:2::1');
    assert.equal(response.body.origin, 'http://direct.test');
    assert.equal(response.body.proxyTrusted, true);
  });

  for (let value of ['', 'unknown', '198.51.100.8,', '198.51.100.8:443', '[::1]', 'fe80::1%lo0', 'bad, 198.51.100.8']) {
    it(`rejects malformed trusted XFF: ${JSON.stringify(value)}`, async () => {
      let response = await request(await proxyApp(loopback)).get('/facts').set('X-Forwarded-For', value);
      assert.equal(response.status, 400);
    });
  }

  for (let header of ['X-Forwarded-Host', 'X-Forwarded-Proto']) {
    it(`rejects repeated physical ${header} from a trusted peer`, async () => {
      let response = await rawHttpResponse(await proxyApp(loopback),
        `GET /facts HTTP/1.1\r\nHost: direct.test\r\n${header}: https\r\n${header}: https\r\nConnection: close\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 400/);
    });
  }

  it('keeps peer and client IP values out of automatic request logs', async () => {
    let logs = [];
    let runtime = await createCricketRuntime(defineCricketApp({
      domains: [], trustProxy: loopback,
      logger: { format: 'json', write(line) { logs.push(JSON.parse(line)); } }
    }));
    try {
      let response = await request(runtime.app).get('/missing').set('Host', 'api.example.test')
        .set('X-Forwarded-For', '198.51.100.77');
      assert.equal(response.status, 404);
      let serialized = JSON.stringify(logs);
      assert.ok(logs.length > 0);
      assert.equal(serialized.includes('198.51.100.77'), false);
      assert.equal(serialized.includes('127.0.0.1'), false);
      assert.equal(serialized.includes('clientIp'), false);
      assert.equal(serialized.includes('peerIp'), false);
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects invalid trusted protocol rather than falling back to HTTP', async () => {
    let response = await request(await proxyApp(loopback)).get('/facts').set('X-Forwarded-Proto', 'javascript');
    assert.equal(response.status, 400);
  });
});
