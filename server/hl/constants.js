// server/hl/constants.js — frozen constants of the Hyperliquid TESTNET integration (PLATFORM §6.1).
//
// Hard rules (PLATFORM §1.2) that these constants make true by construction:
//   • There is NO mainnet exchange URL anywhere in this code base. The only /exchange URL is the testnet one below,
//     and server/hl/exchange.js (the only module that POSTs to it) imports it from here; there is no URL parameter,
//     environment override or constructor option.
//   • The phantom-agent source is the literal "b" (testnet). An L1 action signed with "b" recovers a different,
//     unknown signer on mainnet and is rejected there. No function anywhere accepts a network flag.
// ES module bindings are read-only for importers; objects and arrays are additionally Object.freeze()d.

export const TESTNET_HOST = 'api.hyperliquid-testnet.xyz';
export const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
export const TESTNET_EXCHANGE_URL = 'https://api.hyperliquid-testnet.xyz/exchange';

/** EIP-712 domain of L1 actions (the "Exchange" domain; chainId 1337, zero verifying contract). */
export const L1_DOMAIN = Object.freeze({
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
});

/** Phantom-agent source: "b" = testnet. Mainnet would be "a", which this code never produces. */
export const PHANTOM_SOURCE = 'b';

/** EIP-712 domain name of user-signed actions (P1 approveAgent relay, §6.10). The chainId comes from the wallet. */
export const USER_SIGNED_DOMAIN_NAME = 'HyperliquidSignTransaction';
/** The only `hyperliquidChain` value this code ever accepts or builds (§1.2 rule 6). */
export const HYPERLIQUID_CHAIN = 'Testnet';
/** EIP-712 primary type and fields of the user-signed approveAgent (P1, §6.10; SDK `sign_agent`). */
export const APPROVE_AGENT_PRIMARY_TYPE = 'HyperliquidTransaction:ApproveAgent';
export const APPROVE_AGENT_FIELDS = Object.freeze([
  Object.freeze({ name: 'hyperliquidChain', type: 'string' }),
  Object.freeze({ name: 'agentAddress', type: 'address' }),
  Object.freeze({ name: 'agentName', type: 'string' }),
  Object.freeze({ name: 'nonce', type: 'uint64' }),
]);

/** IOC limit-price slippage for opening and mirror orders (§6.5). */
export const IOC_SLIPPAGE = 0.01;
/** Reduce-only flatten retries widen through these (then every 15 s at the last step, §6.5 / §6.11). */
export const FLATTEN_SLIPPAGE_STEPS = Object.freeze([0.01, 0.025, 0.05]);
/** Exchange minimum order value (USD). */
export const MIN_ORDER_USD = 10;

/**
 * The ONLY action types exchange.js will sign or send (§1.2 "no withdrawals or transfers"). `approveAgent` is
 * allowed only for the P1 browser-wallet relay (it is user-signed by the player's wallet, never by our signer).
 * withdraw3, usdSend, spotSend, usdClassTransfer, sendAsset, vaultTransfer, subAccountTransfer, … are refused.
 */
export const ALLOWED_ACTIONS = Object.freeze(['order', 'cancelByCloid', 'updateLeverage', 'approveAgent']);
/** Of those, the L1 actions our agent signer may sign. */
export const L1_ACTIONS = Object.freeze(['order', 'cancelByCloid', 'updateLeverage']);

/** Request timeout for every testnet info/exchange call (§6.2). */
export const HL_TIMEOUT_MS = 8_000;

/** Weight budget for the testnet host per rolling 60 s (info + exchange, §6.8); burst ceiling for P0 flattens. */
export const TESTNET_BUDGET = 800;
export const TESTNET_BURST = 900;
export const LEDGER_WINDOW_MS = 60_000;
/** HTTP 429 → host-wide back-off (§6.8). */
export const BACKOFF_429_MS = 15_000;
/** Degradation starts when the 60 s weight exceeds this share of the budget (§6.8). */
export const DEGRADE_AT = 0.9;

/** Info request weights (Hyperliquid rate-limits page, §6.8). Time-range requests add 1 per 20 items returned. */
export const INFO_WEIGHT = Object.freeze({
  allMids: 2,
  clearinghouseState: 2,
  spotClearinghouseState: 2,
  orderStatus: 2,
  exchangeStatus: 2,
  l2Book: 2,
  metaAndAssetCtxs: 20,
  extraAgents: 20,
  userAbstraction: 20,
  userRateLimit: 20,
  userFunding: 20,
  userFillsByTime: 20,
  userRole: 60,
});

/** Scheduler priorities, highest first (§6.8). Round-robin across players within one priority. */
export const PRIORITY = Object.freeze({
  FLATTEN: 0, // pause, close, halt, kill, delete, mainnet hit, expiry, inactivity
  MIDS: 1, // testnet allMids
  MIRROR: 2, // mirror orders and leverage
  RECONCILE: 3, // clearinghouseState / spotClearinghouseState
  ORDER_STATUS: 4, // orderStatus (and the agent_unknown userRole confirm)
  FILLS: 5, // fills sweep
  BACKGROUND: 6, // metaAndAssetCtxs / exchangeStatus / userRateLimit / l2Book
  VERIFY: 7, // credential verification
});

/** Time-range info pages hold at most this many rows; a full page means "ask again" (§6.11). */
export const FILLS_PAGE = 500;
/** Only the most recent fills exist on the exchange (§6.8). */
export const FILLS_HORIZON = 10_000;

/** Exchange resend rule after a transport failure: identical bytes at most twice within 10 s (§6.6). */
export const RESEND_MAX = 2;
export const RESEND_WINDOW_MS = 10_000;

/** Taker fee estimate for provisional fills (4.5 bp × notional, §6.11). */
export const PROVISIONAL_FEE_RATE = 0.00045;

/** Testnet market cadences (§6.1, §6.6). */
export const MIDS_POLL_MS = 5_000;
export const META_POLL_MS = 5 * 60_000;
export const CLOCK_POLL_MS = 10 * 60_000;
export const BOOK_TTL_MS = 30_000;
export const BOOK_TTL_DEGRADED_MS = 120_000;
/** Feed state thresholds: no successful info request for > 15 s → delayed, > 60 s → down (§6.11). */
export const DELAYED_AFTER_MS = 15_000;
export const DOWN_AFTER_MS = 60_000;
/** Clock skew thresholds (§6.6). */
export const SKEW_WARN_MS = 5_000;
export const SKEW_DOWN_MS = 60_000;
