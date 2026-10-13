// server/hl/index.js — composition of the Hyperliquid TESTNET integration (PLATFORM §6.1, §12.2).
//
//   createTestnet({fetch, now, sleep, log, budget, mainnetClient}) → {scheduler, info, market, exchange, verify}
//
// `fetch` is injectable: tests and `--testnet-double` pass the in-process double's fetch, so no request ever reaches a
// Hyperliquid host in that mode. Without it, the global fetch is resolved lazily at call time, so the egress guard
// installed by main() always applies. `mainnetClient` is the engine's HyperliquidClient (its queued `userRole` is the
// fail-closed mainnet guard) — or, for --testnet-double, the double's `mainnetInfo`.
//
// This module only builds objects; it starts nothing. WP3 calls market.start() (and stop()) and scheduler.drain().

import { TESTNET_BUDGET, TESTNET_BURST } from './constants.js';
import { TestnetExchange } from './exchange.js';
import { TestnetInfo } from './info.js';
import { TestnetMarket } from './market.js';
import { HlScheduler } from './scheduler.js';
import { createVerifier } from './verify.js';

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.budget=800]            TESTNET_BUDGET (weight per rolling 60 s)
 * @param {number} [opts.burst=900]
 * @param {{userRole: Function}} [opts.mainnetClient]
 * @param {string[]} [opts.coins]               our coins (default: the engine's 16)
 * @param {boolean} [opts.enabled=true]         false → market state 'disabled'
 * @param {object} [opts.timers]                {setTimeout, clearTimeout} for the market loops
 * @param {(uid: any) => string|null} [opts.epochOf]  garden epoch source (or scheduler.setEpochSource later)
 */
export function createTestnet({ fetch: fetchImpl, now = Date.now, sleep, log, budget = TESTNET_BUDGET, burst = TESTNET_BURST,
  mainnetClient = null, coins, enabled = true, timers, epochOf } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const scheduler = new HlScheduler({ budget, burst: Math.max(burst, budget), now, sleep, log: say, epochOf });
  const info = new TestnetInfo({ scheduler, fetch: fetchImpl, now, log: say });
  const exchange = new TestnetExchange({ scheduler, info, fetch: fetchImpl, now, sleep, log: say });
  const market = new TestnetMarket({
    info, scheduler, now, log: say, enabled, signingHalted: () => exchange.signingHalted,
    ...(coins ? { coins } : {}), ...(timers ? { timers } : {}),
  });
  exchange.onSigningHalt(() => market.evaluate());
  const verify = createVerifier({ info, mainnetInfo: mainnetClient, now, log: say, sleep });
  return Object.freeze({ scheduler, info, market, exchange, verify });
}

// Every module's public surface, flat (WP3 binds `lib.wire = lib.format = lib.errors = … = this module`).
export * from './constants.js';
export * from './addr.js';
export * from './egress.js';
export * from './msgpack.js';
export * from './signing.js';
export * from './format.js';
export * from './wire.js';
export * from './errors.js';
export * from './transport.js';
export * from './scheduler.js';
export * from './info.js';
export * from './market.js';
export * from './exchange.js';
export * from './verify.js';
