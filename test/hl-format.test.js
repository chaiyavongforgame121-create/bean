// test/hl-format.test.js — T-FMT: perp price and size wire strings (PLATFORM §6.5). Offline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLATTEN_SLIPPAGE_STEPS, IOC_SLIPPAGE, MIN_ORDER_USD } from '../server/hl/constants.js';
import {
  flattenSlippage, floorSz, fmtPxWire, fmtSzWire, iocPx, isWirePx, isWireSz, stripZeros,
} from '../server/hl/format.js';

describe('§6.5 required examples', () => {
  // [case, function, input, d, expected] — mids from the 2026-10-11 table.
  const PX = [
    ['BTC buy (d=5)', 82306.5 * 1.01, 5, '83130'],
    ['BTC sell', 82306.5 * 0.99, 5, '81483'],
    ['ETH buy (d=4)', 2492.45 * 1.01, 4, '2517.4'],
    ['SOL buy (d=2)', 108.91 * 1.01, 2, '110'],
    ['HYPE buy (d=2)', 41.199 * 1.01, 2, '41.611'],
    ['DOGE buy (d=0)', 0.083946 * 1.01, 0, '0.084785'],
    ['PUMP sell (d=0)', 0.005528 * 0.99, 0, '0.005473'],
    ['ARB buy (d=1)', 0.19367 * 1.01, 1, '0.19561'],
    ['docs: too many sig figs', 1234.56, 0, '1234.6'],
    ['docs: too many decimals', 0.0012345, 0, '0.001234'],
    ['docs: d=1', 0.012345, 1, '0.01235'],
    ['large integer', 123456.7, 0, '123460'],
    ['SDK parity px (d=4)', 1670.1, 4, '1670.1'],
    ['SDK parity px 100 (d=1)', 100, 1, '100'],
    ['SDK parity px 103 (d=1)', 103, 1, '103'],
  ];
  for (const [label, input, d, want] of PX) {
    it(`fmtPxWire — ${label}`, () => {
      assert.equal(fmtPxWire(input, d), want);
      assert.ok(isWirePx(want, d));
    });
  }

  const SZ = [
    ['size BTC', 0.0012345, 5, '0.00123'],
    ['size DOGE', 1234.9, 0, '1234'],
    ['size ETH', 0.1, 4, '0.1'],
    ['size float noise', 2.999999999, 2, '2.99'],
    ['SDK parity sz (d=4)', 0.0147, 4, '0.0147'],
    ['SDK parity sz (d=0)', 100, 0, '100'],
  ];
  for (const [label, input, d, want] of SZ) {
    it(`fmtSzWire — ${label}`, () => {
      assert.equal(fmtSzWire(input, d), want);
      assert.ok(isWireSz(want, d));
    });
  }

  it('the SDK 8-decimal 0.00001231 case has no perp equivalent (documented, not a parity row)', () => {
    assert.equal(fmtPxWire(0.00001231, 0), '0.000012');
    assert.equal(fmtSzWire(0.00001231, 5), '0.00001');
  });
});

describe('formatter properties', () => {
  // A small deterministic PRNG so failures reproduce.
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000_007) / 1_000_000_007;
  };

  it('isWirePx accepts every fmtPxWire output (10k random prices × szDecimals 0..5)', () => {
    for (let i = 0; i < 10_000; i++) {
      const d = i % 6;
      const minExp = -(6 - d) + 0.7; // keep the price representable at 6 − d decimals
      const px = 10 ** (minExp + rnd() * (6 - minExp));
      const s = fmtPxWire(px, d);
      assert.ok(isWirePx(s, d), `${px} d=${d} → ${s}`);
      assert.doesNotMatch(s, /e|-|\.$|\.\d*0$/i, `canonical: ${s}`);
      // 5 significant figures (or an integer) and the decimal limit
      const dec = s.includes('.') ? s.split('.')[1].length : 0;
      assert.ok(dec <= 6 - d);
      // §6.5 rounds twice (5 significant figures, then 6 − d decimals): the error is at most half a unit of each
      const tol = (10 ** (Math.floor(Math.log10(px)) - 4) / 2 + 10 ** -(6 - d) / 2) * (1 + 1e-9);
      assert.ok(Math.abs(Number(s) - px) <= tol + 1e-15, `${px} → ${s}`);
    }
  });

  it('isWirePx refuses non-canonical and out-of-rule strings', () => {
    for (const [s, d] of [['83130.0', 5], ['2517.40', 4], ['1e3', 0], ['-1', 0], ['0', 0], ['00.5', 0], ['0.0000001', 0],
      ['41.6115', 2], ['123456.5', 0], ['', 0], [' 1', 0]]) {
      assert.equal(isWirePx(s, d), false, `${s} d=${d}`);
    }
    assert.equal(isWirePx('123457', 0), true, 'integer prices are always allowed');
  });

  it('sizes never round up and never send zero', () => {
    for (let i = 0; i < 5_000; i++) {
      const d = i % 6;
      const sz = 10 ** (-d + rnd() * 6);
      const s = fmtSzWire(sz, d);
      assert.ok(Number(s) <= sz + 1e-12, `${sz} d=${d} → ${s} rounded up`);
      assert.ok(Number(s) > sz - 10 ** -d - 1e-12, `${sz} d=${d} → ${s} lost more than a lot`);
      assert.ok(isWireSz(s, d));
      const f = floorSz(-sz, d);
      assert.ok(f <= 0 && Math.abs(f) === Number(s), 'floorSz keeps the sign and the same lots');
    }
    assert.throws(() => fmtSzWire(0.000009, 5), RangeError, 'below one lot');
    assert.equal(floorSz(0.000009, 5), 0);
    assert.equal(floorSz(10 * 0.1 * 2.058, 2), 2.05, 'the §6.11 HYPE sizing example (10 units × 0.1 × 2.058 → 2.05)');
  });

  it('fmtPxWire refuses non-positive and non-finite prices and bad decimals', () => {
    for (const px of [0, -1, Number.NaN, Infinity, '100']) assert.throws(() => fmtPxWire(px, 2), RangeError);
    assert.throws(() => fmtPxWire(0.0000001, 0), RangeError, 'rounds to zero, never "0"');
    assert.throws(() => fmtPxWire(100, -1), RangeError);
    assert.throws(() => fmtPxWire(100, 1.5), RangeError);
  });

  it('stripZeros', () => {
    assert.equal(stripZeros('83130.000000'), '83130');
    assert.equal(stripZeros('2.50'), '2.5');
    assert.equal(stripZeros('100'), '100');
  });
});

describe('IOC prices and the flatten slippage steps (§6.5, §6.11)', () => {
  it('opening IOCs use 1 %: buys above the mid, sells below', () => {
    assert.equal(IOC_SLIPPAGE, 0.01);
    assert.equal(iocPx(82306.5, true, IOC_SLIPPAGE, 5), '83130');
    assert.equal(iocPx(82306.5, false, IOC_SLIPPAGE, 5), '81483');
    assert.ok(Number(iocPx(2492.45, true, 0.01, 4)) > 2492.45);
    assert.ok(Number(iocPx(2492.45, false, 0.01, 4)) < 2492.45);
  });

  it('flatten retries widen 1 % → 2.5 % → 5 %, then stay at 5 %', () => {
    assert.deepEqual([...FLATTEN_SLIPPAGE_STEPS], [0.01, 0.025, 0.05]);
    assert.ok(Object.isFrozen(FLATTEN_SLIPPAGE_STEPS));
    assert.deepEqual([0, 1, 2, 3, 10].map(flattenSlippage), [0.01, 0.025, 0.05, 0.05, 0.05]);
    const sells = [0, 1, 2].map((a) => Number(iocPx(2492.45, false, flattenSlippage(a), 4)));
    assert.ok(sells[0] > sells[1] && sells[1] > sells[2], 'each retry reaches further into the book');
  });

  it('the minimum order is $10', () => {
    assert.equal(MIN_ORDER_USD, 10);
  });
});
