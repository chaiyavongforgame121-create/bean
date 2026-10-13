#!/usr/bin/env node
// server/admin-cli.js — the operator tool (PLATFORM.md §4.4, §10.2, §10.6). Run it INSIDE the container:
//
//   docker compose exec bean node server/admin-cli.js status
//   docker compose exec bean node server/admin-cli.js kill on "testnet incident"
//   docker compose exec bean node server/admin-cli.js kill off
//   docker compose exec bean node server/admin-cli.js backup
//   docker compose exec bean node server/admin-cli.js users [query]
//   docker compose exec bean node server/admin-cli.js user <name> <disable|enable|halt|revoke_sessions|disconnect_testnet|reset_password>
//   docker compose exec bean node server/admin-cli.js audit [--user NAME] [--action ACTION] [--limit N]
//   docker compose exec bean node server/admin-cli.js signing resume
//   docker compose exec bean node server/admin-cli.js caps '{"testnet":{"max_bots":2}}'
//
// It reads the admin token from ADMIN_TOKEN_FILE (compose: /run/secrets/admin_token) or ADMIN_TOKEN, and calls
// http://127.0.0.1:<PORT> DIRECTLY, so the server sees a direct loopback peer without proxy headers (the only place
// the Bearer token is accepted unless ADMIN_TOKEN_REMOTE=1) and exempts the Host check. It prints the JSON answer.
// Role changes (make_admin / remove_admin) are refused here: they need an admin session and password in the app.
// This process never logs the token; it only sends it in the Authorization header.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `usage: node server/admin-cli.js <command> [args]   (run inside the container)

  status                          admin_status
  kill on "reason" | kill off     admin_kill_switch (testnet only; paper is unaffected)
  backup                          admin_backup (at most once per 10 min)
  users [query]                   admin_users
  user <name> <action>            admin_user: disable | enable | halt | revoke_sessions | disconnect_testnet | reset_password
  audit [--user N] [--action A] [--limit N]   admin_audit
  signing resume                  admin_testnet_signing (after a signature_mismatch fix is deployed)
  caps '<json>'                   admin_caps, e.g. '{"testnet":{"max_bots":2}}'

env: PORT (8420), ADMIN_TOKEN_FILE (default /run/secrets/admin_token) or ADMIN_TOKEN`;

const DEFAULT_TOKEN_FILE = '/run/secrets/admin_token';
const USER_ACTIONS = ['disable', 'enable', 'halt', 'revoke_sessions', 'disconnect_testnet', 'reset_password'];

class UsageError extends Error {}

/** Read the admin token (file first). Never printed. */
export function readToken(env = process.env) {
  const file = env.ADMIN_TOKEN_FILE || (fs.existsSync(DEFAULT_TOKEN_FILE) ? DEFAULT_TOKEN_FILE : null);
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new UsageError(`cannot read ADMIN_TOKEN_FILE (${err.code ?? err.name})`);
    }
  }
  if (env.ADMIN_TOKEN) return String(env.ADMIN_TOKEN).trim();
  throw new UsageError('no admin token: set ADMIN_TOKEN_FILE (compose secret) or ADMIN_TOKEN');
}

/**
 * Turn argv into one API call. → {method, op, query?, body?}
 * @param {string[]} args
 */
export function planCall(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'status':
      return { method: 'GET', op: 'admin_status' };
    case 'kill': {
      const [state, ...reason] = rest;
      if (state === 'on') return { method: 'POST', op: 'admin_kill_switch', body: { on: true, reason: reason.join(' ') || null } };
      if (state === 'off') return { method: 'POST', op: 'admin_kill_switch', body: { on: false } };
      throw new UsageError('kill needs "on [reason]" or "off"');
    }
    case 'backup':
      return { method: 'POST', op: 'admin_backup', body: {} };
    case 'users':
      return { method: 'GET', op: 'admin_users', query: rest[0] ? { q: rest[0] } : {} };
    case 'user': {
      const [username, action] = rest;
      if (!username || !action) throw new UsageError('user needs <name> <action>');
      if (action === 'make_admin' || action === 'remove_admin') {
        throw new UsageError(`${action} needs an admin session and password: use the Operator panel in the app`);
      }
      if (!USER_ACTIONS.includes(action)) throw new UsageError(`action must be one of ${USER_ACTIONS.join(', ')}`);
      return { method: 'POST', op: 'admin_user', body: { username, action } };
    }
    case 'audit': {
      const query = {};
      for (let i = 0; i < rest.length; i += 2) {
        const key = { '--user': 'user', '--action': 'action', '--limit': 'limit', '--offset': 'offset' }[rest[i]];
        if (!key || rest[i + 1] === undefined) throw new UsageError('audit takes --user, --action, --limit, --offset');
        query[key] = rest[i + 1];
      }
      return { method: 'GET', op: 'admin_audit', query };
    }
    case 'signing':
      if (rest[0] !== 'resume') throw new UsageError('signing takes "resume"');
      return { method: 'POST', op: 'admin_testnet_signing', body: { resume: true } };
    case 'caps': {
      let patch;
      try {
        patch = JSON.parse(rest.join(' '));
      } catch {
        throw new UsageError('caps needs a JSON object, e.g. \'{"testnet":{"max_bots":2}}\'');
      }
      return { method: 'POST', op: 'admin_caps', body: patch };
    }
    default:
      throw new UsageError(cmd ? `unknown command '${cmd}'` : 'no command');
  }
}

/** Perform one call against the local server. → {status, json} */
export async function callApi({ method, op, query = {}, body }, { port, token, fetchImpl = fetch }) {
  const url = new URL(`http://127.0.0.1:${port}/api/v1/${op}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  let plan;
  let token;
  try {
    plan = planCall(argv);
    token = readToken(env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`admin-cli: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  const port = Number(env.PORT || 8420);
  try {
    const { status, json } = await callApi(plan, { port, token });
    console.log(JSON.stringify(json, null, 2));
    return status >= 200 && status < 300 ? 0 : 1;
  } catch (err) {
    console.error(`admin-cli: cannot reach the server on 127.0.0.1:${port} (${err.cause?.code ?? err.code ?? err.name})`);
    return 1;
  }
}

const isEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    const a = fs.realpathSync.native(process.argv[1]);
    const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().then((code) => {
    process.exitCode = code;
  });
}
