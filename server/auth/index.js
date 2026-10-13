// server/auth/index.js — builds the accounts-mode platform bag (PLATFORM.md §2.4 rule 2, §3, §4, §5, §10.5).
//
// One call at boot (main.js, accounts mode only; none mode never calls it and never opens SQLite):
//
//   const platform = await createPlatform({ config, dataDir, feed, stateFile, log });
//   platform.setHooks({ closeStreams, deleteGarden, testnetLink, haltGarden, teardown, disconnectTestnet, notifyUser });
//   platform.start();                       // backups + retention timers
//   … createServer({ …, config: { auth: 'accounts', … }, platform }) …
//   await platform.close();                 // shutdown step 5: checkpoint + close (after gardens.flush())
//
// Boot order: open DB → migrate (pre-migration backup; MigrationError → exit 3) → audit salt → secrets (+ P0/P1
// rotation step) → hasher (DUMMY_HASH) → admin service → users (+ ADMIN_USERNAMES promotion, bootstrap code file) →
// sessions → auth service → request guard and client-IP resolver → backup and retention schedulers.

import path from 'node:path';

import { openDb, dbFileFor, MIGRATIONS_DIR } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { Backups } from '../db/backup.js';
import { Retention } from '../db/retention.js';
import { Secrets, loadAuditSalt } from '../secrets.js';
import { Admin } from '../admin.js';
import { PasswordHasher } from './passwords.js';
import { Users } from './users.js';
import { Sessions } from './sessions.js';
import { RateLimiter, UnknownNameLockouts, StreamSlots } from './ratelimit.js';
import { createClientIp } from './clientip.js';
import { createRequestGuard, directLoopback, checkBearerParams } from './csrf.js';
import { AuthService } from './service.js';

export { checkBearerParams, directLoopback };

/**
 * @param {object} o
 * @param {object} o.config     parseConfig() output in accounts mode (parsePlatformConfig fields + port, accountUsd,
 *                              maxBots, maxBotCapitalUsd); its non-enumerable `secrets` carries the keys
 * @param {string} o.dataDir
 * @param {'hyperliquid'|'sim'} o.feed
 * @param {string|null} [o.stateFile]   copied beside each backup
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {{N: number, r: number, p: number}} [o.hasherParams]  tests only
 */
export async function createPlatform({ config, dataDir, feed, stateFile = null, log = () => {}, now = Date.now, hasherParams = undefined }) {
  if (config?.auth !== 'accounts') throw new Error('createPlatform: accounts mode only');
  const secretsIn = config.secrets ?? {};
  const db = openDb({ file: dbFileFor(dataDir, feed), log });
  try {
    const backupDir = path.join(dataDir, 'backups');
    migrate(db, MIGRATIONS_DIR, { backupDir, log, now });

    const secrets = new Secrets({ masterKey: secretsIn.masterKey ?? null, oldKeys: secretsIn.oldKeys ?? [], auditSalt: loadAuditSalt(db, now) });
    const rotation = secrets.applyRotation(db, { now, log });
    if (secretsIn.masterKeyEphemeral) log('[secrets] --testnet-double without a master key: using an ephemeral key (credentials do not survive a restart)');

    const hasher = await new PasswordHasher(hasherParams ? { params: hasherParams } : {}).init();
    const limiter = new RateLimiter({ signupMaxPerHour: config.signupMaxPerHour ?? 60, now });
    const lockouts = new UnknownNameLockouts({ now });
    const admin = new Admin(db, {
      now,
      log,
      secrets,
      hasher,
      signupMode: config.signupMode ?? 'open',
      defaultCaps: {
        paper: pick({ account_usd: config.accountUsd, max_bots: config.maxBots, max_bot_capital_usd: config.maxBotCapitalUsd }),
      },
    });
    if (rotation.resealed > 0) admin.audit({ action: 'keys_resealed', actor: 'system', ok: true, detail: { count: rotation.resealed } });
    if (rotation.unavailable > 0) {
      admin.audit({ action: 'keys_resealed', actor: 'system', ok: false, detail: { count: rotation.unavailable, code: 'key_unavailable' } });
    }
    const users = new Users(db, {
      hasher,
      lockouts,
      adminUsernames: config.adminUsernames ?? [],
      accountUsd: () => admin.getCaps().paper.account_usd,
      now,
      log,
    });
    users.bootstrap({ dataDir, configuredCode: secretsIn.bootstrapCode ?? null });
    const sessions = new Sessions(db, {
      publicOrigin: config.publicOrigin,
      secrets,
      sessionDays: config.sessionDays ?? 30,
      idleDays: config.sessionIdleDays ?? 7,
      now,
    });
    admin.users = users;
    admin.sessions = sessions;
    const auth = new AuthService({ users, sessions, hasher, limiter, admin, secrets, log });
    const clientIp = createClientIp({
      trustProxy: config.trustProxy ?? 0,
      header: config.clientIpHeader ?? null,
      trustedCidrs: config.trustedProxyCidrs,
      log,
      // Behind a proxy: one log line (no addresses) describing the first forwarded request — the §10.7 #9 check.
      diagnose: (config.trustProxy ?? 0) >= 1 || Boolean(config.clientIpHeader),
    });
    const guard = createRequestGuard({
      publicOrigin: config.publicOrigin,
      port: config.port ?? null,
      adminToken: secretsIn.adminToken ?? null,
      adminTokenRemote: Boolean(config.adminTokenRemote),
      limiter,
      audit: (entry) => admin.audit(entry),
    });
    const backups = new Backups({
      db, dir: backupDir, stateFile, intervalH: config.backupIntervalH ?? 6, keep: config.backupKeep ?? 28, now, log,
    });
    const retention = new Retention({ db, now, log });
    const streamSlots = new StreamSlots();

    let closed = false;
    const platform = {
      db, secrets, hasher, limiter, lockouts, admin, users, sessions, auth, clientIp, guard, backups, retention, streamSlots,
      publicOrigin: config.publicOrigin,

      /** Wire the garden / stream side effects (each optional). */
      setHooks(hooks = {}) {
        auth.setHooks(hooks);
        admin.setHooks(hooks);
        return platform;
      },

      /** admin_backup's work (http.js applies the 10-min limit and the audit row): one online backup now. */
      backup: () => backups.runNow(),

      /** The request context the auth service and guard expect. */
      requestContext(req) {
        const ua = req.headers?.['user-agent'];
        return { ip: clientIp(req), userAgent: typeof ua === 'string' ? ua : null, req, auth: sessions.authenticate(req) };
      },

      /** /readyz: the DB answers. */
      ready() {
        try {
          return !closed && db.ping();
        } catch {
          return false;
        }
      },

      start() {
        backups.start();
        retention.start();
        return platform;
      },

      /** Stop timers, let a running backup finish, checkpoint and close the DB. Idempotent. */
      async close() {
        if (closed) return;
        closed = true;
        backups.stop();
        retention.stop();
        await backups.idle();
        try {
          db.checkpoint();
        } catch (err) {
          log(`[db] final checkpoint failed (${err.code ?? err.name})`);
        }
        db.close();
      },
    };
    return platform;
  } catch (err) {
    db.close();
    throw err;
  }
}

function pick(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
}
