const dns = require('node:dns').promises;
const net = require('node:net');

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

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new BlockedAddressError(`Could not resolve host: ${host}`);
  }

  if (addresses.length === 0) {
    throw new BlockedAddressError(`Could not resolve host: ${host}`);
  }

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
  isBlockedAddress
};
