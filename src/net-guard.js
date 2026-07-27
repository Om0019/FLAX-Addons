const dns = require('node:dns').promises;
const net = require('node:net');
const { createTtlCache } = require('./ttl-cache');

// The /proxy route fetches a caller-supplied URL and returns the body, which is a
// server-side request forgery primitive unless the destination is constrained: on a
// cloud host http://169.254.169.254/ hands out instance credentials, and anything on
// the loopback or LAN interface is reachable that a remote caller should never see.
//
// Note that a bare IP host is NOT itself suspicious here. Some sources legitimately
// serve streams from raw IPv4 addresses (see the 'pelisplus-ip' family in the
// orchestrator, which scores them best of all), so the filter has to reject the
// private and reserved ranges specifically rather than IP literals as a class.

const MAX_REDIRECT_HOPS = 5;

// Every hop of every proxied request resolves its host, and for HLS that is once
// per segment for the whole of playback — Node's dns.lookup is getaddrinfo on the
// libuv threadpool, which is four threads shared with all other blocking work, so
// a few viewers can queue behind each other on name resolution alone.
//
// SECURITY TRADE-OFF, read before changing: caching a resolution means a host that
// resolved publicly is trusted for up to the TTL, which widens the DNS-rebinding
// window this module already documents as open. Kept deliberately short, and only
// the *addresses* are cached — never the verdict — so every request still runs the
// full block-list check against them. Set PROXY_DNS_CACHE_TTL_MS=0 to resolve on
// every hop, which is the pre-cache behaviour.
const DEFAULT_DNS_CACHE_TTL_MS = 30 * 1000;
const DNS_CACHE_MAX_HOSTS = 500;

const dnsCache = createTtlCache({ maxEntries: DNS_CACHE_MAX_HOSTS });
// Concurrent segment requests for the same host on a cold cache would each start
// their own lookup; they share one instead.
const inFlightLookups = new Map();

function dnsCacheTtlMs() {
  const configured = Number.parseInt(process.env.PROXY_DNS_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_DNS_CACHE_TTL_MS;
}

// Escape hatch for the deliberate case: someone self-hosting the addon alongside a
// media source on their own LAN, and the test suite, which necessarily runs its
// origins on loopback. Off unless explicitly set, because turning it on restores
// the full SSRF surface — it must never be enabled on a host reachable by others.
function privateTargetsAllowed() {
  return process.env.ALLOW_PRIVATE_PROXY_TARGETS === '1';
}

class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [a, b, c] = octets;

  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // RFC1918 private
  if (a === 127) return true;                        // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 carrier NAT
  if (a === 169 && b === 254) return true;           // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918 private
  if (a === 192 && b === 0 && c === 0) return true;  // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true;  // TEST-NET-1
  if (a === 192 && b === 168) return true;           // RFC1918 private
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;   // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;    // TEST-NET-3
  if (a >= 224) return true;                         // multicast, reserved, broadcast

  return false;
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];

  // IPv4-mapped and NAT64 forms carry a v4 address that must be judged as v4,
  // otherwise ::ffff:127.0.0.1 walks straight past a v6-only check.
  const embeddedIpv4 = normalized.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embeddedIpv4) {
    return isBlockedIpv4(embeddedIpv4[1]);
  }

  if (normalized === '::' || normalized === '::1') return true;    // unspecified, loopback
  if (/^f[cd]/.test(normalized)) return true;                      // fc00::/7 unique local
  if (/^fe[89ab]/.test(normalized)) return true;                   // fe80::/10 link-local
  if (/^ff/.test(normalized)) return true;                         // ff00::/8 multicast

  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * Resolves `host` to its addresses, sharing a cached answer and any lookup already
 * in flight. Only successful resolutions are cached: a transient DNS failure must
 * not be pinned in place, and a failure is cheap to retry.
 */
async function resolveHost(host) {
  const ttlMs = dnsCacheTtlMs();

  if (ttlMs > 0) {
    const cached = dnsCache.get(host);
    if (cached) return cached;
  }

  const pending = inFlightLookups.get(host);
  if (pending) return pending;

  const lookup = dns.lookup(host, { all: true })
    .then((addresses) => {
      if (!addresses || addresses.length === 0) {
        throw new BlockedAddressError(`Could not resolve host: ${host}`);
      }
      if (ttlMs > 0) dnsCache.set(host, addresses, ttlMs);
      return addresses;
    })
    .catch((error) => {
      if (error instanceof BlockedAddressError) throw error;
      throw new BlockedAddressError(`Could not resolve host: ${host}`);
    })
    .finally(() => {
      inFlightLookups.delete(host);
    });

  inFlightLookups.set(host, lookup);
  return lookup;
}

/**
 * Resolves a URL's host and rejects it when any address it maps to is private,
 * loopback, link-local or otherwise reserved.
 *
 * Residual risk: between this check and the fetch, a hostile DNS server can change
 * the answer to a blocked address (DNS rebinding). Closing that requires pinning
 * the connection to the vetted IP, which the fetch API does not expose. The check
 * still removes the direct and redirect-based paths, which are what an attacker
 * reaches for first.
 */
async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError(`Invalid url: ${rawUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BlockedAddressError(`Unsupported protocol: ${parsed.protocol}`);
  }

  if (privateTargetsAllowed()) {
    return parsed;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedAddressError(`Blocked address: ${host}`);
    }
    return parsed;
  }

  // "localhost" and friends usually resolve to loopback anyway, but a resolver is
  // free to disagree, so reject the name outright rather than trusting DNS.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) {
    throw new BlockedAddressError(`Blocked hostname: ${host}`);
  }

  const addresses = await resolveHost(host);

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedAddressError(`Blocked address for ${host}: ${address}`);
    }
  }

  return parsed;
}

/**
 * Sync counterpart for hot paths that cannot await DNS. Only judges literal
 * addresses, so it is a filter rather than a guarantee — use assertPublicUrl
 * anywhere the response is actually returned to a caller.
 */
function hasBlockedIpLiteralHost(rawUrl) {
  if (privateTargetsAllowed()) return false;

  try {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
    return net.isIP(host) ? isBlockedAddress(host) : false;
  } catch {
    return false;
  }
}

module.exports = {
  BlockedAddressError,
  privateTargetsAllowed,
  MAX_REDIRECT_HOPS,
  assertPublicUrl,
  hasBlockedIpLiteralHost,
  isBlockedAddress,
  __test: { dnsCache, inFlightLookups }
};
