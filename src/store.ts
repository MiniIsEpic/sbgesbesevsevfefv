import Redis from 'ioredis';
import { DEFAULT_THRESHOLD_USD, redisUrl } from './config.js';
import type { EncBlob } from './crypto.js';
import type { Addresses } from './derive.js';
import type { Network } from './networks.js';

let client: Redis | null = null;
// One connection, reused across warm invocations. TLS is used automatically for rediss:// URLs.
const r = () =>
  (client ??= new Redis(redisUrl(), {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    enableReadyCheck: true,
  }));

export interface ForwardRule {
  to: string;
  minUsd: number;
}

/** One account (sub-wallet) of a seed, e.g. main.0, main.1. */
export interface Account {
  index: number;
  addresses: Addresses;
  forward?: Record<string, ForwardRule>;
}

/** One imported seed phrase and the accounts tracked under it. */
export interface Wallet {
  label: string;
  pool: Addresses[];
  accounts: Account[];
  enc: EncBlob;
  networks: string[];
  withdraw: boolean;
  threshold?: number;
  createdAt: number;
  autoEnc?: EncBlob;
}

export interface Settings {
  pinSalt?: string;
  pinHash?: string;
  threshold: number;
  failed: number;
  lockedUntil: number;
}

export type Pending =
  | { kind: 'setpin' }
  | { kind: 'changepin' }
  | { kind: 'import-label' }
  | { kind: 'import'; label: string }
  | { kind: 'import-multi' }
  | { kind: 'withdraw-pin' }
  | { kind: 'autosend-pin' }
  | { kind: 'wd-amount'; label: string; index: number; net: string }
  | { kind: 'wd-address'; label: string; index: number; net: string; amount: string }
  | { kind: 'as-min'; label: string; index: number; net: string }
  | { kind: 'as-address'; label: string; index: number; net: string; minUsd: number }
  | { kind: 'th-custom' };

export interface PendingWithdraw {
  label: string;
  index: number;
  net: string;
  amount: string;
  to: string;
  createdAt: number;
}

export interface PendingAutosend {
  label: string;
  index: number;
  net: string;
  minUsd: number;
  to: string;
}

export const ref = (label: string, index: number) => `${label}.${index}`;
export const hasForwardRules = (w: Wallet) => w.accounts.some((a) => Object.keys(a.forward ?? {}).length > 0);

const K = {
  users: 'users',
  settings: (u: number) => `u:${u}:settings`,
  wallets: (u: number) => `u:${u}:wallets`,
  cursor: (u: number) => `u:${u}:cursor`,
  pending: (u: number) => `u:${u}:pending`,
  withdraw: (u: number) => `u:${u}:withdraw`,
  autosend: (u: number) => `u:${u}:autosend`,
  lock: (u: number) => `u:${u}:lock`,
  seen: (u: number, key: string) => `u:${u}:seen:${key}`,
  networks: 'custom:networks',
};

const parse = <T>(s: string | null | undefined): T | null => (s ? (JSON.parse(s) as T) : null);

/** Upgrades wallets saved by the single-account version. */
function upgrade(w: Wallet & { addresses?: Addresses; forward?: Account['forward'] }): Wallet {
  if (!w.accounts && w.addresses) {
    w.pool = [w.addresses];
    w.accounts = [{ index: 0, addresses: w.addresses, forward: w.forward }];
    delete w.addresses;
    delete w.forward;
  }
  return w;
}

// ---- settings ----
export async function getSettings(uid: number): Promise<Settings> {
  const s = parse<Partial<Settings>>(await r().get(K.settings(uid)));
  return { threshold: DEFAULT_THRESHOLD_USD, failed: 0, lockedUntil: 0, ...s };
}
export async function saveSettings(uid: number, s: Settings) {
  await r().set(K.settings(uid), JSON.stringify(s));
}

// ---- wallets ----
export async function listWallets(uid: number): Promise<Wallet[]> {
  const h = await r().hgetall(K.wallets(uid));
  return h ? Object.values(h).map((v) => upgrade(JSON.parse(v))).sort((a, b) => a.createdAt - b.createdAt) : [];
}
export async function getWallet(uid: number, label: string): Promise<Wallet | null> {
  const w = parse<Wallet>(await r().hget(K.wallets(uid), label));
  return w ? upgrade(w) : null;
}
export async function saveWallet(uid: number, w: Wallet) {
  w.accounts.sort((a, b) => a.index - b.index);
  await r().hset(K.wallets(uid), w.label, JSON.stringify(w));
  await r().sadd(K.users, String(uid));
}
export async function deleteWallet(uid: number, label: string) {
  await r().hdel(K.wallets(uid), label);
  await deleteCursors(uid, label);
}
export async function listUsers(): Promise<number[]> {
  return (await r().smembers(K.users)).map(Number);
}

// ---- tracking cursors: field "<label>:<index>:<net>" ----
export async function getCursor(uid: number, label: string, index: number, net: string): Promise<string | null> {
  return (await r().hget(K.cursor(uid), `${label}:${index}:${net}`)) ?? null;
}
export async function setCursor(uid: number, label: string, index: number, net: string, value: string) {
  await r().hset(K.cursor(uid), `${label}:${index}:${net}`, value);
}
export async function deleteCursors(uid: number, label: string, only: { index?: number; net?: string } = {}) {
  const keys = (await r().hkeys(K.cursor(uid))).filter((k) => {
    const [l, i, n] = k.split(':');
    return l === label && (only.index === undefined || Number(i) === only.index) && (only.net === undefined || n === only.net);
  });
  if (keys.length) await r().hdel(K.cursor(uid), ...keys);
}

/** True the first time a key is seen (kept 3 days). Stops the same tx being alerted or auto-sent twice. */
export async function markSeen(uid: number, key: string): Promise<boolean> {
  return (await r().set(K.seen(uid, key), '1', 'EX', 3 * 86400, 'NX')) === 'OK';
}

// ---- short-lived conversation state ----
export async function setPending(uid: number, p: Pending, ttlSec = 120) {
  await r().set(K.pending(uid), JSON.stringify(p), 'EX', ttlSec);
}
export async function getPending(uid: number): Promise<Pending | null> {
  return parse<Pending>(await r().get(K.pending(uid)));
}
export async function clearPending(uid: number) {
  await r().del(K.pending(uid));
}
export async function setWithdraw(uid: number, w: PendingWithdraw) {
  await r().set(K.withdraw(uid), JSON.stringify(w), 'EX', 300);
}
export async function getWithdraw(uid: number): Promise<PendingWithdraw | null> {
  return parse<PendingWithdraw>(await r().get(K.withdraw(uid)));
}
export async function clearWithdraw(uid: number) {
  await r().del(K.withdraw(uid));
}
export async function setAutosend(uid: number, a: PendingAutosend) {
  await r().set(K.autosend(uid), JSON.stringify(a), 'EX', 300);
}
export async function getAutosend(uid: number): Promise<PendingAutosend | null> {
  return parse<PendingAutosend>(await r().get(K.autosend(uid)));
}
export async function clearAutosend(uid: number) {
  await r().del(K.autosend(uid));
}

// 120s > the 60s function limit, so a run that gets killed mid-way can't overlap with the next one.
export async function acquireLock(uid: number, ttlSec = 120): Promise<boolean> {
  return (await r().set(K.lock(uid), '1', 'EX', ttlSec, 'NX')) === 'OK';
}
export async function releaseLock(uid: number) {
  await r().del(K.lock(uid));
}

// ---- misc cache ----
export async function getJson<T>(key: string): Promise<T | null> {
  return parse<T>(await r().get(key));
}
export async function setJson(key: string, value: unknown, ttlSec?: number) {
  if (ttlSec) await r().set(key, JSON.stringify(value), 'EX', ttlSec);
  else await r().set(key, JSON.stringify(value));
}

// ---- custom EVM networks ----
export async function listCustomNetworks(): Promise<Network[]> {
  const h = await r().hgetall(K.networks);
  return h ? Object.values(h).map((v) => JSON.parse(v) as Network) : [];
}
export async function saveCustomNetwork(n: Network) {
  await r().hset(K.networks, n.key, JSON.stringify(n));
}
export async function deleteCustomNetwork(key: string) {
  await r().hdel(K.networks, key);
}
