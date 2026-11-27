import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createOAuthMetadataFetcher } from '../src/oauth/fetch-metadata.js';

let documentUrl = 'https://client.example/client.json';
let publicAddress = { address: '8.8.8.8', family: 4 };
let publicIpv6 = { address: '2606:4700::1111', family: 6 };
let metadata = { client_id: documentUrl, client_name: 'Sample client' };

function createHttpsFixture({
  chunks = [Buffer.from(JSON.stringify(metadata))],
  status = 200,
  headers = {}
} = {}) {
  let requests = [];
  function request(url, options, respond) {
    requests.push({ url, options });
    return Object.assign(new EventEmitter(), {
      end() {
        let response = Readable.from(chunks);
        response.statusCode = status;
        response.headers = headers;
        respond(response);
      }
    });
  }
  return { requests, request };
}

test('checks every DNS answer and pins the validated addresses for HTTPS', async () => {
  let { request, requests } = createHttpsFixture();
  let hosts = [];
  let fetchMetadata = createOAuthMetadataFetcher({
    request,
    async lookup(hostname, options) {
      hosts.push(hostname);
      assert.equal(options.all, true);
      return [publicAddress, publicIpv6];
    }
  });
  assert.deepEqual(await fetchMetadata(documentUrl), metadata);
  assert.deepEqual(hosts, ['client.example']);
  assert.equal(requests.length, 1);
  let [{ url, options }] = requests;
  assert.equal(url.hostname, 'client.example');
  assert.equal(options.agent, false);
  options.lookup(url.hostname, { all: true }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [publicAddress, publicIpv6]);
  });
  options.lookup(url.hostname, { family: 6 }, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, publicIpv6.address);
    assert.equal(family, 6);
  });
});

test('rejects mixed DNS answers and special-use destinations before contacting HTTPS', async () => {
  let { request, requests } = createHttpsFixture();
  for (let address of [
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.2',
    '169.254.0.1',
    '192.0.2.10',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff02::1'
  ]) {
    let fetchMetadata = createOAuthMetadataFetcher({
      request,
      async lookup() {
        return [publicAddress, { address, family: address.includes(':') ? 6 : 4 }];
      }
    });
    await assert.rejects(fetchMetadata(documentUrl), /public destination addresses/);
  }
  let fetchMetadata = createOAuthMetadataFetcher({ request });
  await assert.rejects(fetchMetadata('https://127.0.0.2/client.json'), /public destination/);
  await assert.rejects(fetchMetadata('http://client.example/client.json'), /requires an HTTPS URL/);
  await assert.rejects(
    fetchMetadata('https://user:password@client.example/client.json'),
    /requires an HTTPS URL/
  );
  assert.equal(requests.length, 0);
});

test('rejects redirects and invalid JSON with no follow-up request', async () => {
  let lookup = async () => [publicAddress];
  let redirected = createHttpsFixture({
    headers: { location: 'https://other.example/client.json' },
    status: 302
  });
  let fetchMetadata = createOAuthMetadataFetcher({ lookup, request: redirected.request });
  await assert.rejects(fetchMetadata(documentUrl), /status 200/);
  assert.equal(redirected.requests.length, 1);

  let invalid = createHttpsFixture({ chunks: [Buffer.from('null')] });
  fetchMetadata = createOAuthMetadataFetcher({ lookup, request: invalid.request });
  await assert.rejects(fetchMetadata(documentUrl), /must be a JSON object/);
  assert.equal(invalid.requests.length, 1);
});

test('bounds streamed client metadata and JWKS with a separate limit for each', async () => {
  let lookup = async () => [publicAddress];
  let body = Buffer.from(JSON.stringify({ keys: [{ kid: 'x'.repeat(6 * 1024) }] }));
  let jwks = createHttpsFixture({ chunks: [body.subarray(0, 4000), body.subarray(4000)] });
  let fetchMetadata = createOAuthMetadataFetcher({ lookup, request: jwks.request });
  await assert.rejects(fetchMetadata(documentUrl), /response is too large/);
  assert.equal(
    (await fetchMetadata(documentUrl, { kind: 'jwks' })).keys[0].kid.length,
    6 * 1024
  );
  let oversized = createHttpsFixture({ chunks: [Buffer.alloc(50 * 1024 + 1)] });
  fetchMetadata = createOAuthMetadataFetcher({ lookup, request: oversized.request });
  await assert.rejects(fetchMetadata(documentUrl, { kind: 'jwks' }), /response is too large/);
});

test('returns promptly when the request is canceled while DNS is pending', async () => {
  let controller = new AbortController();
  let { request, requests } = createHttpsFixture();
  let fetchMetadata = createOAuthMetadataFetcher({
    request,
    lookup() {
      controller.abort(new Error('caller canceled'));
      return new Promise(() => {});
    }
  });
  await assert.rejects(fetchMetadata(documentUrl, { signal: controller.signal }), /caller canceled/);
  assert.equal(requests.length, 0);
});
