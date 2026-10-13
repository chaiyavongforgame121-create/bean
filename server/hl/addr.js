// server/hl/addr.js — address normalization (PLATFORM §6.7, review P16).
//
// Hyperliquid and its SDK use EIP-55 mixed-case addresses in places (e.g. `userRole.data.user`, the SDK's
// approve_agent posts the checksummed `account.address`), and the signing docs recommend lower-casing. EVERY address
// comparison and every stored address therefore goes through these helpers: lower-case `0x` + 40 hex, or nothing.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FIRST_ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/** A `bad_address` error. The message never echoes the input (it might be a pasted secret). */
export class AddressError extends Error {
  constructor() {
    super('bad_address');
    this.name = 'AddressError';
    this.code = 'bad_address';
  }
}

/** True when `s` is a well-formed `0x` + 40-hex address (any case, surrounding whitespace allowed). */
export function isAddr(s) {
  return typeof s === 'string' && ADDR_RE.test(s.trim());
}

/** → lower-case `0x…40`; throws AddressError (`code: 'bad_address'`) otherwise. */
export function normAddr(s) {
  if (typeof s !== 'string') throw new AddressError();
  const t = s.trim();
  if (!ADDR_RE.test(t)) throw new AddressError();
  return t.toLowerCase();
}

/** Case-insensitive address equality. Malformed input is never equal to anything. */
export function sameAddr(a, b) {
  if (!isAddr(a) || !isAddr(b)) return false;
  return normAddr(a) === normAddr(b);
}

/** The first `0x…40` address inside a text (exchange error messages, §6.9), normalized; or null. */
export function firstAddr(text) {
  if (typeof text !== 'string') return null;
  const m = FIRST_ADDR_RE.exec(text);
  return m ? m[0].toLowerCase() : null;
}

/** Display form for admins and error vars: `0x1234…abcd` (never the full address in admin lists, §5.4). */
export function truncAddr(a) {
  if (!isAddr(a)) return null;
  const n = normAddr(a);
  return `${n.slice(0, 6)}…${n.slice(-4)}`;
}
