// server/auth/clientip.js — the client IP and its rate-limit buckets (PLATFORM.md §4.5).
//
// The socket peer IS the client IP unless the peer is a trusted proxy (TRUSTED_PROXY_CIDRS). Only then:
//   * CLIENT_IP_HEADER set (e.g. fly-client-ip) → that single header;
//   * otherwise TRUST_PROXY = N ≥ 1 → the N-th address from the RIGHT of X-Forwarded-For (Caddy appends the real
//     peer, so N = 1 is correct for Caddy directly on the internet). A shorter XFF falls back to the socket address
//     (warned once).
// So a client that reaches the port directly cannot choose its own bucket by writing X-Forwarded-For.
//
// Buckets: IPv4 per address; IPv6 per /56 for login, sign-up and SSE counting, /48 for the per-prefix sign-up
// budget, /64 elsewhere. Sessions store a coarser prefix for the session list: /24 (v4) or /48 (v6).

import net from 'node:net';

export const DEFAULT_TRUSTED_PROXY_CIDRS = Object.freeze([
  '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fdaa::/16',
]);

/** Scope → IPv6 prefix length for bucket keys (§4.5). Anything else uses /64. */
const V6_BUCKET_BITS = Object.freeze({ login: 56, signup: 56, sse: 56, signup48: 48 });

// ---------------------------------------------------------------------------------------------
// Address parsing

/**
 * Normalise an address string: strips an IPv6 zone and brackets, and maps ::ffff:a.b.c.d to a.b.c.d.
 * @returns {{family: 4|6, bytes: Uint8Array, text: string} | null}
 */
export function parseIp(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const family = net.isIP(s);
  if (family === 4) {
    const bytes = Uint8Array.from(s.split('.').map(Number));
    return { family: 4, bytes, text: bytes.join('.') };
  }
  if (family !== 6) return null;
  const bytes = v6Bytes(s);
  if (!bytes) return null;
  // IPv4-mapped (::ffff:0:0/96) → IPv4, so a dual-stack socket and an XFF entry agree.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = bytes.slice(12);
    return { family: 4, bytes: v4, text: Array.from(v4).join('.') };
  }
  return { family: 6, bytes, text: v6Text(bytes) };
}

function v6Bytes(s) {
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → two hextets.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (net.isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = rest === null ? head : [...head, ...new Array(8 - head.length - rest.length).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[2 * i] = v >> 8;
    bytes[2 * i + 1] = v & 0xff;
  }
  return bytes;
}

/** Canonical-ish IPv6 text (RFC 5952 style: lower-case, longest zero run compressed). */
function v6Text(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best === -1) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

/** The address masked to `bits`, as text "addr/bits". */
function prefixText(ip, bits) {
  const bytes = Uint8Array.from(ip.bytes);
  for (let i = 0; i < bytes.length; i += 1) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    bytes[i] &= keep === 8 ? 0xff : (0xff << (8 - keep)) & 0xff;
  }
  return `${ip.family === 4 ? Array.from(bytes).join('.') : v6Text(bytes)}/${bits}`;
}

// ---------------------------------------------------------------------------------------------
// CIDRs

/**
 * Parse a CIDR list ("a.b.c.d/n, x::/n" or an array). Throws on any bad entry (config refuses to start).
 * @returns {{family: 4|6, bytes: Uint8Array, bits: number, text: string}[]}
 */
export function parseCidrs(list) {
  const items = Array.isArray(list) ? list : String(list ?? '').split(',');
  const out = [];
  for (const raw of items) {
    const item = String(raw).trim();
    if (!item) continue;
    const slash = item.indexOf('/');
    const ip = parseIp(slash === -1 ? item : item.slice(0, slash));
    if (!ip) throw new Error(`bad CIDR entry '${item}'`);
    const max = ip.family === 4 ? 32 : 128;
    let bits = max;
    if (slash !== -1) {
      const b = item.slice(slash + 1);
      if (!/^\d{1,3}$/.test(b) || Number(b) > max) throw new Error(`bad CIDR prefix length in '${item}'`);
      bits = Number(b);
      // An IPv4-mapped IPv6 CIDR (::ffff:10.0.0.0/104) parses as IPv4: rebase its length.
      if (ip.family === 4 && item.slice(0, slash).includes(':')) bits = Math.max(0, bits - 96);
    }
    out.push({ family: ip.family, bytes: ip.bytes, bits, text: item });
  }
  return out;
}

export function cidrContains(cidr, ip) {
  if (!ip || cidr.family !== ip.family) return false;
  let bits = cidr.bits;
  for (let i = 0; bits > 0; i += 1, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((cidr.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Client IP

/**
 * Bucket key of an address for a rate-limit scope (§4.5).
 * @param {{family: 4|6, text: string, bytes: Uint8Array}} ip
 * @param {string} scope  'login' | 'signup' | 'sse' (/56 on v6) | 'signup48' (/48) | anything else (/64)
 */
export function bucketKeyOf(ip, scope = 'default') {
  if (!ip) return 'unknown';
  if (ip.family === 4) return ip.text;
  return prefixText(ip, V6_BUCKET_BITS[scope] ?? 64);
}

/** The stored session-list prefix: /24 (v4) or /48 (v6). Text in, text out (null when not an IP). */
export function ipPrefix(address) {
  const ip = typeof address === 'string' ? parseIp(address) : address;
  if (!ip) return null;
  return prefixText(ip, ip.family === 4 ? 24 : 48);
}

/**
 * Build a client-IP resolver from the parsed config (one per server; it remembers the "short XFF" warning).
 * @param {object} cfg
 * @param {number} [cfg.trustProxy]      TRUST_PROXY (0 = never read XFF)
 * @param {string|null} [cfg.header]     CLIENT_IP_HEADER (lower-case) or null
 * @param {Array|string} [cfg.trustedCidrs]  TRUSTED_PROXY_CIDRS (default list)
 * @param {(line: string) => void} [cfg.log]
 * @param {boolean} [cfg.diagnose]  log ONE line describing the first request that arrives through a trusted proxy
 *   (how many X-Forwarded-For entries, which single-IP headers the edge adds, and whether they agree with the address
 *   chosen) — header names, counts and yes/no only, never an address. The §10.7 #9 check on hosts whose proxy chain
 *   is not documented (Render, Railway): read it in the platform logs after the first visit. Also ONE line (no
 *   address) when a request carrying X-Forwarded-For (or the configured header) comes from a peer OUTSIDE
 *   TRUSTED_PROXY_CIDRS while TRUST_PROXY / CLIENT_IP_HEADER is set: the forwarded address is ignored, every player
 *   would share the proxy's address, and the fix is TRUSTED_PROXY_CIDRS (deploy/render/README.md section 4).
 */
export function createClientIp({ trustProxy = 0, header = null, trustedCidrs = DEFAULT_TRUSTED_PROXY_CIDRS, log = () => {}, diagnose = false } = {}) {
  const cidrs = trustedCidrs.length && typeof trustedCidrs[0] === 'object' ? trustedCidrs : parseCidrs(trustedCidrs);
  const headerName = header ? String(header).toLowerCase() : null;
  let warnedShortXff = false;
  let diagnosed = !diagnose;
  let warnedUntrusted = !diagnose || (trustProxy < 1 && !headerName);
  const stats = new BucketStats();

  /** @returns {{ip: string, source: 'socket'|'xff'|'header', family: 4|6|0, bucketKey: (scope?: string) => string}} */
  function resolve(req) {
    const peer = parseIp(req?.socket?.remoteAddress ?? '');
    let chosen = peer;
    let source = 'socket';
    const trustedPeer = Boolean(peer && cidrs.some((c) => cidrContains(c, peer)));
    if (trustedPeer) {
      if (headerName) {
        const value = firstHeader(req.headers?.[headerName]);
        const parsed = value ? parseIp(value) : null;
        if (parsed) {
          chosen = parsed;
          source = 'header';
        }
      } else if (trustProxy >= 1) {
        const xff = req.headers?.['x-forwarded-for'];
        const list = (Array.isArray(xff) ? xff.join(',') : String(xff ?? ''))
          .split(',').map((s) => s.trim()).filter(Boolean);
        const parsed = list.length >= trustProxy ? parseIp(list[list.length - trustProxy]) : null;
        if (parsed) {
          chosen = parsed;
          source = 'xff';
        } else if (!warnedShortXff) {
          warnedShortXff = true;
          log(`[clientip] X-Forwarded-For from a trusted proxy had fewer than TRUST_PROXY=${trustProxy} valid entries: using the socket address (logged once)`);
        }
      }
    }
    // The first request a trusted proxy forwarded (it carries X-Forwarded-For or the configured header): one line.
    const forwarded = req.headers?.['x-forwarded-for'] !== undefined || (headerName && req.headers?.[headerName] !== undefined);
    if (!diagnosed && trustedPeer && forwarded) {
      diagnosed = true;
      log(describeProxied(req, { chosen, source, trustProxy, headerName }));
    }
    if (!warnedUntrusted && !trustedPeer && forwarded) {
      warnedUntrusted = true;
      const family = peer ? `IPv${peer.family}` : 'unparseable';
      log(`[clientip] proxy peer not in TRUSTED_PROXY_CIDRS (an ${family} socket address): its ${headerName ?? 'X-Forwarded-For'} is ignored, ` +
        'so every client shares that address. Add the proxy range to TRUSTED_PROXY_CIDRS (logged once; no addresses are logged)');
    }
    const result = {
      ip: chosen ? chosen.text : 'unknown',
      source,
      family: chosen ? chosen.family : 0,
      bucketKey: (scope) => bucketKeyOf(chosen, scope),
      prefix: () => (chosen ? ipPrefix(chosen) : null),
    };
    stats.note(result.bucketKey('default'));
    return result;
  }

  resolve.source = headerName ? 'header' : trustProxy >= 1 ? 'xff' : 'socket';
  resolve.stats = stats;
  return resolve;
}

/** Single-IP headers an edge may add; compared (yes/no) with the chosen address by the diagnose line. */
const EDGE_IP_HEADERS = Object.freeze(['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'fly-client-ip']);

/** The one-time diagnose line: counts, header names and yes/no — never an address. */
function describeProxied(req, { chosen, source, trustProxy, headerName }) {
  const xff = req.headers?.['x-forwarded-for'];
  const entries = (Array.isArray(xff) ? xff.join(',') : String(xff ?? '')).split(',').map((v) => v.trim()).filter(Boolean).length;
  const seen = [];
  for (const name of EDGE_IP_HEADERS) {
    const value = firstHeader(req.headers?.[name]);
    if (value === null) continue;
    const ip = parseIp(value);
    seen.push(`${name} (${ip && chosen && ip.text === chosen.text ? 'same as the chosen address' : 'DIFFERENT from the chosen address'})`);
  }
  const how = source === 'header' ? `CLIENT_IP_HEADER=${headerName}` : source === 'xff' ? `X-Forwarded-For entry ${trustProxy} from the right (TRUST_PROXY=${trustProxy})` : 'the socket address';
  return `[clientip] first request through a trusted proxy: X-Forwarded-For has ${entries} entr${entries === 1 ? 'y' : 'ies'}; ` +
    `client IP taken from ${how}; edge headers: ${seen.length ? seen.join(', ') : 'none'} (logged once; no addresses are logged)`;
}

/**
 * The frozen §12.2 form: clientIp(req, {trustProxy, header, trustedCidrs}) → {ip, source, bucketKey(scope)}.
 * Prefer createClientIp() in the server (it parses the CIDRs once).
 */
export function clientIp(req, opts = {}) {
  return createClientIp(opts)(req);
}

function firstHeader(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return null;
  // A single-IP header should hold one address; if a hop appended more, the rightmost is the one the trusted
  // edge wrote.
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Distinct /64-or-v4 buckets seen in the last hour (admin_status.client_ip.buckets_1h): two rotating generations,
 * so memory is bounded by the traffic of two hours, capped at 200,000 keys.
 */
export class BucketStats {
  constructor({ now = Date.now, windowMs = 3_600_000, cap = 200_000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.cap = cap;
    this.current = new Set();
    this.previous = new Set();
    this.rotatedAt = now();
  }

  note(key) {
    this.#rotate();
    if (this.current.size < this.cap) this.current.add(key);
  }

  /** Approximate distinct buckets over the last 1–2 h. */
  count() {
    this.#rotate();
    let n = this.current.size;
    for (const k of this.previous) if (!this.current.has(k)) n += 1;
    return n;
  }

  #rotate() {
    const t = this.now();
    if (t - this.rotatedAt < this.windowMs) return;
    this.previous = t - this.rotatedAt < 2 * this.windowMs ? this.current : new Set();
    this.current = new Set();
    this.rotatedAt = t;
  }
}
