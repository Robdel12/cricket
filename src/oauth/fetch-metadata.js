import { Buffer } from 'node:buffer';
import { lookup as resolveHost } from 'node:dns/promises';
import { addAbortListener } from 'node:events';
import { request as sendRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

let ipv6Global = new BlockList();
ipv6Global.addSubnet('2000::', 3, 'ipv6');

let specialUse = new BlockList();
// IANA special-purpose addresses, plus the IPv4 multicast range.
for (let [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  specialUse.addSubnet(address, prefix);
}
for (let [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20]
]) {
  specialUse.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress({ address, family }) {
  if (isIP(address) !== family) return false;
  if (family === 4) return !specialUse.check(address);
  return family === 6 && ipv6Global.check(address, 'ipv6') && !specialUse.check(address, 'ipv6');
}

async function lookupBeforeAbort(lookup, hostname, signal) {
  signal.throwIfAborted();
  let listener;
  let aborted = new Promise((_, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    return await Promise.race([lookup(hostname, { all: true }), aborted]);
  } finally {
    listener[Symbol.dispose]();
  }
}

function pinAddresses(hostname, addresses) {
  return (name, options, callback) => {
    let candidates = addresses.filter(({ family }) => !options.family || family === options.family);
    if (name !== hostname || candidates.length === 0) {
      callback(new Error('No validated address available for OAuth metadata'));
    } else if (options.all) {
      callback(null, candidates);
    } else {
      callback(null, candidates[0].address, candidates[0].family);
    }
  };
}

async function readJson(response, maxBytes, signal) {
  if (response.statusCode !== 200) throw new Error('OAuth metadata response must have status 200');
  if (Number(response.headers['content-length']) > maxBytes) {
    throw new Error('OAuth metadata response is too large');
  }
  let encoding = response.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new Error('OAuth metadata response must use identity encoding');
  }

  let chunks = [];
  let total = 0;
  for await (let chunk of response) {
    signal.throwIfAborted();
    total += chunk.length;
    if (total > maxBytes) throw new Error('OAuth metadata response is too large');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  let value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OAuth metadata must be a JSON object');
  }
  return value;
}

export function createOAuthMetadataFetcher({
  lookup = resolveHost,
  request = sendRequest
} = {}) {
  return async function fetchOAuthMetadata(url, { kind = 'client', signal: parentSignal } = {}) {
    if (kind !== 'client' && kind !== 'jwks') throw new TypeError('Unknown OAuth metadata kind');
    let destination = new URL(url);
    if (
      destination.protocol !== 'https:' ||
      destination.username ||
      destination.password ||
      destination.hash
    ) {
      throw new Error('OAuth metadata requires an HTTPS URL without credentials or a fragment');
    }

    let deadline = AbortSignal.timeout(2500);
    let signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
    let hostname = destination.hostname.replace(/^\[|\]$/g, '');
    let family = isIP(hostname);
    let addresses = family
      ? [{ address: hostname, family }]
      : await lookupBeforeAbort(lookup, hostname, signal);
    if (!addresses.length || !addresses.every(isPublicAddress)) {
      throw new Error('OAuth metadata requires public destination addresses');
    }
    signal.throwIfAborted();

    let response = await new Promise((resolve, reject) => {
      let outgoing = request(
        destination,
        {
          agent: false,
          lookup: pinAddresses(hostname, addresses),
          signal,
          headers: {
            Accept: kind === 'jwks' ? 'application/jwk-set+json, application/json' : 'application/json',
            'Accept-Encoding': 'identity'
          }
        },
        resolve
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    try {
      return await readJson(response, kind === 'jwks' ? 50 * 1024 : 5 * 1024, signal);
    } finally {
      response.destroy();
    }
  };
}

/** Fetch bounded OAuth client metadata or public keys over HTTPS from publicly routable addresses. */
export let fetchOAuthMetadata = createOAuthMetadataFetcher();
