import { getBalance } from './chains/index.js';
import { toFloat } from './format.js';
import { getAllNetworks } from './networks.js';
import { getPrices } from './prices.js';
import * as store from './store.js';
import { mapLimit } from './util.js';

export interface NetRow {
  net: string;
  name: string;
  symbol: string;
  amount: string; // base units as string (JSON-safe)
  decimals: number;
  usd?: number;
}

export interface AcctBalance {
  ref: string; // e.g. main.0
  label: string;
  index: number;
  usd: number;
  rows: NetRow[];
}

export interface BalanceSnapshot {
  accounts: AcctBalance[];
  total: number;
  at: number;
}

const CACHE = (uid: number) => `bal:snapshot:${uid}`;
const TTL = 60; // seconds — so paging through the menu doesn't refetch every tap

/** All accounts' native balances in USD, cached briefly. Pass force=true to refetch now. */
export async function getBalanceSnapshot(uid: number, force = false): Promise<BalanceSnapshot> {
  if (!force) {
    const cached = await store.getJson<BalanceSnapshot>(CACHE(uid)).catch(() => null);
    if (cached) return cached;
  }

  const wallets = await store.listWallets(uid);
  const nets = await getAllNetworks();
  const prices = await getPrices(nets.map((n) => n.coingeckoId));
  const targets = wallets.flatMap((w) => w.accounts.map((a) => ({ w, a })));

  const accounts = await mapLimit(targets, 5, async ({ w, a }) => {
    const enabled = nets.filter((n) => w.networks.includes(n.key));
    const rows = await mapLimit(enabled, 4, async (n): Promise<NetRow | null> => {
      try {
        const bal = await getBalance(n, a.addresses);
        if (bal === 0n) return null;
        const price = prices[n.coingeckoId];
        return {
          net: n.key,
          name: n.name,
          symbol: n.symbol,
          amount: bal.toString(),
          decimals: n.decimals,
          usd: price !== undefined ? toFloat(bal, n.decimals) * price : undefined,
        };
      } catch {
        return null;
      }
    });
    const clean = rows.filter((r): r is NetRow => r !== null);
    const usd = clean.reduce((s, r) => s + (r.usd ?? 0), 0);
    return { ref: store.ref(w.label, a.index), label: w.label, index: a.index, usd, rows: clean };
  });

  accounts.sort((a, b) => b.usd - a.usd); // most valuable first, like the reference bot
  const total = accounts.reduce((s, a) => s + a.usd, 0);
  const snapshot: BalanceSnapshot = { accounts, total, at: Date.now() };
  await store.setJson(CACHE(uid), snapshot, TTL).catch(() => {});
  return snapshot;
}

export async function clearBalanceCache(uid: number) {
  await store.setJson(CACHE(uid), { accounts: [], total: 0, at: 0 }, 1).catch(() => {});
}
