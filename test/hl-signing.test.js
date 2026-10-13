// test/hl-signing.test.js — KAT gate for Hyperliquid TESTNET signing (PLATFORM §6.4, §6.12). Offline.
//
// Vectors: hyperliquid-python-sdk tests/signing_test.py (master, re-fetched read-only 2026-10-11; they match §6.12).
// r and s are compared NUMERICALLY (BigInt): the SDK's to_hex(int) strips leading zeros. v must match exactly.
// KAT-3 (vault) and KAT-U1 (user-signed UsdSend) are built with test-only helpers here, so server/ keeps "no vault"
// and "no usdSend" by construction.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encode } from '@msgpack/msgpack';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { PackError, packAction } from '../server/hl/msgpack.js';
import {
  AGENT_TYPEHASH_HEX, L1_DOMAIN_SEPARATOR_HEX, SECP256K1_N, actionHash, addressOf, agentDigest, isValidScalar,
  makeSigner, recoverDigest, recoverL1, recoverUserSigned, splitSignature, toHex, u64be, userSignedDigest,
} from '../server/hl/signing.js';
import { orderAction, orderWire, updateLeverageAction } from '../server/hl/wire.js';

const KEY_HEX = '0123456789012345678901234567890123456789012345678901234567890123';
const key = () => Uint8Array.from(Buffer.from(KEY_HEX, 'hex'));
const KAT_A = '0x14791697260e4c9a71f18484c9f997b308e59325';

const sameSig = (got, want, label) => {
  assert.equal(BigInt(got.r), BigInt(want.r), `${label}: r`);
  assert.equal(BigInt(got.s), BigInt(want.s), `${label}: s`);
  assert.equal(got.v, want.v, `${label}: v`);
};

const dummy = () => ({ type: 'dummy', num: 100000000000 }); // float_to_int_for_hashing(1000)
const kat4 = () => orderAction([orderWire({ asset: 1, isBuy: true, px: '100', sz: '100', reduceOnly: false, tif: 'Gtc' })]);
const kat5 = () => orderAction([orderWire({ asset: 1, isBuy: true, px: '100', sz: '100', reduceOnly: false, tif: 'Gtc', cloid: '0x00000000000000000000000000000001' })]);
const kat6 = () => orderAction([orderWire({ asset: 1, isBuy: true, px: '100', sz: '100', reduceOnly: false, trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } })]);

// Official testnet ("b") vectors, nonce 0 (KAT-3 is checked separately: it needs the vault hash layout).
const VECTORS = [
  ['KAT-2 dummy', dummy, { r: '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', s: '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', v: 28 }],
  ['KAT-4 order GTC', kat4, { r: '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', s: '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', v: 27 }],
  ['KAT-5 order + cloid', kat5, { r: '0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d', s: '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', v: 28 }],
  ['KAT-6 trigger sl', kat6, { r: '0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4', s: '0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac', v: 28 }],
  ['KAT-7 scheduleCancel', () => ({ type: 'scheduleCancel' }), { r: '0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed', s: '0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df', v: 28 }],
  ['KAT-8 scheduleCancel time', () => ({ type: 'scheduleCancel', time: 123456789 }), { r: '0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc', s: '0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678', v: 27 }],
];

/** TEST-ONLY: the SDK action_hash with a vault (server/ never sends a vault, §6.12). */
function actionHashWithVault(action, vault, nonce) {
  const vaultBytes = Buffer.from(vault.slice(2), 'hex');
  return keccak_256(Uint8Array.from(Buffer.concat([Buffer.from(packAction(action)), Buffer.from(u64be(nonce)), Buffer.from([1]), vaultBytes])));
}

const signDigest = (digest) => {
  const sig = secp256k1.sign(digest, key(), { lowS: true });
  return { r: `0x${sig.r.toString(16)}`, s: `0x${sig.s.toString(16)}`, v: 27 + sig.recovery };
};

describe('KATs (official SDK vectors, testnet source "b")', () => {
  it('KAT-A: the key derives the documented address', () => {
    assert.equal(addressOf(key()), KAT_A);
    assert.equal(makeSigner(key()).address, KAT_A);
  });

  it('KAT-1: phantom-agent connectionId of the production order (source-independent; no source asserted)', () => {
    const action = orderAction([orderWire({ asset: 4, isBuy: true, px: '1670.1', sz: '0.0147', reduceOnly: false, tif: 'Ioc' })]);
    assert.equal(`0x${toHex(actionHash(action, 1677777606040))}`, '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
  });

  it('KAT-1 bytes match the annotated msgpack of §6.4', () => {
    const action = orderAction([orderWire({ asset: 4, isBuy: true, px: '1670.1', sz: '0.0147', reduceOnly: false, tif: 'Ioc' })]);
    const want = '83a474797065a56f72646572a66f72646572739186a16104a162c3a170a6313637302e31a173a6302e30313437a172c2a17481a56c696d697481a3746966a3496f63a867726f7570696e67a26e61';
    assert.equal(toHex(packAction(action)), want);
    assert.equal(toHex(u64be(1677777606040)), '00000186a3569598');
  });

  for (const [label, build, want] of VECTORS) {
    it(`${label}: signL1 reproduces r, s, v; KAT-R recovers KAT-A`, () => {
      const signer = makeSigner(key());
      const sig = signer.signL1(build(), 0);
      sameSig(sig, want, label);
      assert.equal(recoverL1(build(), 0, sig), KAT_A);
      assert.equal(recoverL1(build(), 0, want), KAT_A, 'the official (possibly unpadded) vector recovers too');
    });
  }

  it('KAT-3: dummy action with vault 0x1719…75ea (hash layout only)', () => {
    const digest = agentDigest(actionHashWithVault(dummy(), '0x1719884eb866cb12b2287399b15f7db5e7d775ea', 0));
    const want = { r: '0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b', s: '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', v: 27 };
    sameSig(signDigest(digest), want, 'KAT-3');
    assert.equal(recoverDigest(digest, want), KAT_A, 'KAT-R for KAT-3');
  });

  it('KAT-D1 / KAT-D2: domain separator and Agent typehash', () => {
    assert.equal(L1_DOMAIN_SEPARATOR_HEX, '0xd79297fcdf2ffcd4ae223d01edaa2ba214ff8f401d7c9300d995d17c82aa4040');
    assert.equal(AGENT_TYPEHASH_HEX, '0x26f05c2f7239b6983075e58321292d77b3aa173d19b27257ac96ab362570f508');
  });

  it('KAT-M1 / M2 / M3: msgpack bytes and connectionId', () => {
    assert.equal(`0x${toHex(packAction(kat4()))}`,
      '0x83a474797065a56f72646572a66f72646572739186a16101a162c3a170a3313030a173a3313030a172c2a17481a56c696d697481a3746966a3477463a867726f7570696e67a26e61');
    assert.equal(`0x${toHex(actionHash(kat4(), 0))}`, '0x884f2c32bb6dbdd65f6033e32fb28c0cb6f5b345db0f6471fd3366d85c9252c1');
    assert.equal(`0x${toHex(packAction(updateLeverageAction(0, 5)))}`,
      '0x84a474797065ae7570646174654c65766572616765a5617373657400a7697343726f7373c2a86c6576657261676505');
  });

  it('integers use the smallest unsigned msgpack form (u8 / u16 / u32 / u64)', () => {
    const bytesOf = (n) => toHex(packAction({ type: 'dummy', num: n })).slice(toHex(packAction({ type: 'dummy', num: 0 })).length - 2);
    assert.equal(bytesOf(0x7f), '7f');
    assert.equal(bytesOf(0x80), 'cc80');
    assert.equal(bytesOf(0x100), 'cd0100');
    assert.equal(bytesOf(0x10000), 'ce00010000');
    assert.equal(bytesOf(100000000000), 'cf000000174876e800');
    assert.equal(toHex(packAction(dummy())), toHex(encode(dummy())), 'plain @msgpack/msgpack defaults');
  });

  it('the official MAINNET vectors are NOT reproducible (no "a" source exists)', () => {
    const sig = makeSigner(key()).signL1(dummy(), 0);
    assert.notEqual(BigInt(sig.r), BigInt('0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298'));
    const ord = makeSigner(key()).signL1(kat4(), 0);
    assert.notEqual(BigInt(ord.r), BigInt('0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e'));
    // A mainnet-signed vector recovers a foreign address under our testnet digest.
    const mainnet = { r: '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', s: '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', v: 27 };
    assert.notEqual(recoverL1(dummy(), 0, mainnet), KAT_A);
  });
});

describe('KAT-U1: user-signed EIP-712 (HyperliquidSignTransaction), the P1 approveAgent domain code', () => {
  const types = [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ];
  const message = { hyperliquidChain: 'Testnet', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 };
  const want = { r: '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073', s: '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7', v: 27 };
  const chainId = parseInt('0x66eee', 16); // signatureChainId hex string → domain chainId integer (421614)

  it('the SDK test_sign_usd_transfer_action vector', () => {
    const digest = userSignedDigest('HyperliquidTransaction:UsdSend', types, message, chainId);
    sameSig(signDigest(digest), want, 'KAT-U1');
    assert.equal(recoverUserSigned('HyperliquidTransaction:UsdSend', types, message, chainId, want), KAT_A);
  });

  it('a Mainnet chain string or another chain id recovers someone else', () => {
    assert.notEqual(recoverUserSigned('HyperliquidTransaction:UsdSend', types, { ...message, hyperliquidChain: 'Mainnet' }, chainId, want), KAT_A);
    assert.notEqual(recoverUserSigned('HyperliquidTransaction:UsdSend', types, message, 42161, want), KAT_A);
  });

  it('splitSignature handles v as 27/28 and 0/1', () => {
    const r = want.r.slice(2).padStart(64, '0');
    const s = want.s.slice(2).padStart(64, '0');
    assert.deepEqual(splitSignature(`0x${r}${s}1b`), { r: `0x${r}`, s: `0x${s}`, v: 27 });
    assert.deepEqual(splitSignature(`0x${r}${s}01`), { r: `0x${r}`, s: `0x${s}`, v: 28 });
    assert.throws(() => splitSignature(`0x${r}${s}05`));
    assert.throws(() => splitSignature('0x1234'));
  });
});

describe('packAction guards', () => {
  const good = () => orderAction([orderWire({ asset: 4, isBuy: true, px: '2517.4', sz: '0.02', reduceOnly: false, cloid: '0x0123456789abcdef0123456789abcdef' })]);
  const refuses = (action, label) => assert.throws(() => packAction(action), PackError, label);

  it('accepts the builders’ output', () => {
    assert.ok(packAction(good()) instanceof Uint8Array);
    assert.ok(packAction(updateLeverageAction(135, 10)) instanceof Uint8Array);
  });

  it('refuses undefined, floats, NaN, negatives, unsafe integers and BigInt anywhere', () => {
    refuses({ type: 'dummy', num: undefined }, 'undefined');
    refuses({ type: 'dummy', num: 1.5 }, 'float');
    refuses({ type: 'dummy', num: Number.NaN }, 'NaN');
    refuses({ type: 'dummy', num: Infinity }, 'Infinity');
    refuses({ type: 'dummy', num: -1 }, 'negative');
    refuses({ type: 'dummy', num: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe');
    refuses({ type: 'dummy', num: 10n }, 'BigInt');
    refuses({ type: 'dummy', when: new Date(0) }, 'non-plain object');
    refuses({ type: 'dummy', f: () => 1 }, 'function');
    const a = good();
    a.orders[0].p = 2517.4; // a float price is a bug
    refuses(a, 'float price');
  });

  it('refuses wrong key order (top level, order wire, order type, updateLeverage, cancelByCloid)', () => {
    const top = good();
    refuses({ type: 'order', grouping: top.grouping, orders: top.orders }, 'grouping before orders');
    const w = good().orders[0];
    refuses({ type: 'order', orders: [{ a: w.a, b: w.b, s: w.s, p: w.p, r: w.r, t: w.t, c: w.c }], grouping: 'na' }, 's before p');
    refuses({ type: 'order', orders: [{ c: w.c, a: w.a, b: w.b, p: w.p, s: w.s, r: w.r, t: w.t }], grouping: 'na' }, 'c first');
    refuses({ type: 'order', orders: [{ ...w, t: { trigger: { triggerPx: '103', isMarket: true, tpsl: 'sl' } } }], grouping: 'na' }, 'trigger key order');
    refuses({ type: 'updateLeverage', isCross: false, asset: 0, leverage: 5 }, 'updateLeverage order');
    refuses({ type: 'cancelByCloid', cancels: [{ cloid: w.c, asset: 4 }] }, 'cancel order');
    refuses({ orders: [], type: 'order', grouping: 'na' }, 'type not first');
  });

  it('refuses non-canonical decimals (trailing zeros, exponents, signs) and bad cloids', () => {
    for (const p of ['2517.40', '2517.', '1e3', '+1', '-1', '01.5', '', ' 1']) {
      const a = good();
      a.orders[0].p = p;
      refuses(a, `price ${JSON.stringify(p)}`);
    }
    const c = good();
    c.orders[0].c = '0x0123456789ABCDEF0123456789ABCDEF';
    refuses(c, 'upper-case cloid');
    const t = good();
    t.orders[0].t = { limit: { tif: 'IOC' } };
    refuses(t, 'unknown tif');
  });
});

describe('signer properties', () => {
  it('signatures are low-s, and r/s are always zero-padded to 64 hex digits', () => {
    const signer = makeSigner(key());
    let leadingZero = 0;
    for (let n = 1; n <= 120; n++) {
      const sig = signer.signL1(dummy(), n);
      assert.match(sig.r, /^0x[0-9a-f]{64}$/);
      assert.match(sig.s, /^0x[0-9a-f]{64}$/);
      assert.ok(BigInt(sig.s) <= SECP256K1_N / 2n, 'low-s');
      assert.ok(sig.v === 27 || sig.v === 28);
      if (sig.r[2] === '0' || sig.s[2] === '0') leadingZero++;
    }
    assert.ok(leadingZero > 0, 'the padding path was exercised');
  });

  it('isValidScalar boundaries 0, 1, n−1, n (own BigInt check, no noble call)', () => {
    const be = (v) => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'));
    assert.equal(isValidScalar(be(0n)), false);
    assert.equal(isValidScalar(be(1n)), true);
    assert.equal(isValidScalar(be(SECP256K1_N - 1n)), true);
    assert.equal(isValidScalar(be(SECP256K1_N)), false);
    assert.equal(isValidScalar(be((1n << 256n) - 1n)), false);
    assert.equal(isValidScalar(new Uint8Array(31).fill(1)), false);
    assert.equal(isValidScalar('01'.repeat(32)), false);
    assert.equal(isValidScalar(null), false);
    assert.ok(!/secp256k1|noble/.test(isValidScalar.toString()), 'isValidScalar never calls into noble');
  });

  it('makeSigner keeps the caller’s bytes by reference: zeroing them destroys the signer', () => {
    const k = key();
    const signer = makeSigner(k);
    assert.deepEqual(Object.keys(signer), ['address', 'signL1']);
    assert.ok(Object.isFrozen(signer));
    assert.equal(signer.signL1.length, 2, 'signL1(action, nonce) — no network flag');
    signer.signL1(dummy(), 1);
    k.fill(0);
    assert.throws(() => signer.signL1(dummy(), 2), (err) => err.code === 'signer_destroyed' && !/0123456789/.test(err.message));
  });

  it('refuses invalid keys and nonces without echoing them', () => {
    assert.throws(() => makeSigner(new Uint8Array(32)), (err) => err.code === 'bad_key_format');
    const signer = makeSigner(key());
    for (const n of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => signer.signL1(dummy(), n));
  });

  it('a flipped recovery bit recovers a different address (what the self-check guards)', () => {
    const sig = makeSigner(key()).signL1(kat4(), 0);
    assert.notEqual(recoverL1(kat4(), 0, { ...sig, v: sig.v === 27 ? 28 : 27 }), KAT_A);
  });
});
