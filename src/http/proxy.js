import { BlockList, isIP } from 'node:net';

import { badRequest } from '../errors.js';
import { isPlainObject } from '../immutable.js';

let matchers = new WeakMap();

// Keep socket objects private; every exposed address is a validated IP literal.
function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value))
    return null;
  if (isIP(value) === 4)
    return value;
  let normalizedAddress = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  let mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalizedAddress);
  if (!mapped)
    return normalizedAddress;
  let high = Number.parseInt(mapped[1], 16);
  let low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

function matcherFor(config) {
  let matcher = matchers.get(config);
  if (matcher)
    return matcher;
  matcher = new BlockList();
  for (let peer of config.peers) {
    let [address, prefix] = peer.split('/');
    let family = isIP(address);
    let type = family === 4 ? 'ipv4' : 'ipv6';
    if (!family || address.includes('%') ||
        (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))))
      throw new Error(`Invalid trustProxy peer: ${peer}`);
    if (prefix === undefined)
      matcher.addAddress(address, type);
    else
      matcher.addSubnet(address, Number(prefix), type);
  }
  matchers.set(config, matcher);
  return matcher;
}

export function normalizeTrustProxy(value = false) {
  if (value === false)
    return false;
  if (!isPlainObject(value) ||
      Object.keys(value).some(key => key !== 'peers') ||
      !Array.isArray(value.peers) || !value.peers.length ||
      value.peers.some(peer => typeof peer !== 'string' || !peer || peer.split('/').length > 2))
    throw new Error('trustProxy must be false or { peers: [IP addresses or CIDRs] }');
  let config = Object.freeze({ peers: Object.freeze([...value.peers]) });
  matcherFor(config);
  return config;
}

export function proxyFacts(req, config) {
  let peerIp = normalizeIp(req.socket?.remoteAddress);
  let matcher = config ? matcherFor(config) : undefined;
  let trusted = ip => ip !== null && matcher?.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6') === true;
  let proxyTrusted = trusted(peerIp);
  if (!proxyTrusted)
    return { peerIp, clientIp: peerIp, proxyTrusted: false };

  let values = [];
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'x-forwarded-for')
      values.push(req.rawHeaders[index + 1]);
  }
  if (!values.length && req.headers['x-forwarded-for'] !== undefined)
    values = [req.headers['x-forwarded-for']].flat();
  let hops = values.flatMap(value => String(value).split(',')).map(value => normalizeIp(value.trim()));
  if (hops.some(ip => ip === null))
    throw badRequest('Invalid x-forwarded-for header');
  let clientIp = peerIp;
  for (let index = hops.length - 1; index >= 0 && trusted(clientIp); index--)
    clientIp = hops[index];
  return { peerIp, clientIp, proxyTrusted };
}
