// server/pulse.js — ephemeral, in-memory broadcast for high-rate stream-only events (GAME-DESIGN §10.7).
//
// The journal is the durable event log (seq ids, ring buffer, jsonl file, Last-Event-ID replay). The pulse is
// its opposite: `mids` marks every ~5 s are worth showing NOW and worthless a minute later, so they are
// never journaled, never get an `id:` line on the SSE stream (Last-Event-ID is untouched), are never
// replayed, and are not returned by the `events` query.
//
//   pulse.publish('mids', data) → message {kind:'mids', ...data} to every subscriber
//   pulse.subscribe(fn) → unsubscribe
//
// SCOPED MODE (accounts mode, PLATFORM §7.5). `new Pulse({ scoped: true })` carries only the SHARED part of a
// frame. publish() THROWS when a frame carries a garden key (`bots`, `account`, `testnet_account`): one
// player's marks must never ride a frame that every stream receives. The SSE writer attaches each subscriber's
// own garden part (gardens.marksFor(uid)) at write time, per stream.

/** Keys that belong to one player's garden and may never be part of a shared (scoped) frame. */
export const GARDEN_KEYS = Object.freeze(['bots', 'account', 'testnet_account']);

/** Thrown by a scoped pulse for a frame that carries garden data. */
export class PulseScopeError extends Error {
  constructor(kind, key) {
    super(`scoped pulse refuses a '${kind}' frame carrying '${key}' (garden data is attached per subscriber)`);
    this.name = 'PulseScopeError';
    this.code = 'garden_key_in_shared_frame';
  }
}

export class Pulse {
  /** @param {{log?: (line:string) => void, scoped?: boolean}} [opts] */
  constructor({ log = console.warn, scoped = false } = {}) {
    this.subscribers = new Set();
    this.log = typeof log === 'function' ? log : () => {};
    this.published = 0;
    this.scoped = scoped === true;
  }

  /**
   * Broadcast one ephemeral message. A throwing subscriber never breaks the others.
   * @returns {object} the message `{ kind, ...data }`
   */
  publish(kind, data = {}) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('pulse kind must be a non-empty string');
    if (this.scoped && data && typeof data === 'object') {
      for (const key of GARDEN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          this.log(`[pulse] ALERT refused a shared '${kind}' frame carrying '${key}'`);
          throw new PulseScopeError(kind, key);
        }
      }
    }
    const msg = { kind };
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) if (key !== 'kind') msg[key] = data[key];
    }
    this.published++;
    for (const fn of this.subscribers) {
      try {
        fn(msg);
      } catch (err) {
        this.log(`[pulse] subscriber failed: ${err?.message || err}`);
      }
    }
    return msg;
  }

  /** @returns {() => void} unsubscribe */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get size() {
    return this.subscribers.size;
  }
}
