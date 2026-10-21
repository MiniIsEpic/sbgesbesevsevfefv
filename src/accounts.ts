import { getActivity, getBalance } from './chains/index.js';
import { deriveMany, MAX_ACCOUNTS, type Addresses } from './derive.js';
import { getAllNetworks } from './networks.js';
import * as store from './store.js';
import { mapLimit } from './util.js';

/** Derives the public address set for every account index of a seed (no secrets stored). */
export function buildPool(phrase: string): Addresses[] {
  return deriveMany(phrase, Array.from({ length: MAX_ACCOUNTS }, (_, i) => i));
}

/**
 * Finds which account indexes have ever been used, by checking each account's balance across all
 * built-in networks. Account 0 is always included. Stops after 3 empty accounts in a row (the gap
 * limit wallet apps use), so a fresh seed returns just [0] instead of 20 idle accounts.
 */
export async function discoverAccounts(pool: Addresses[]): Promise<number[]> {
  const nets = await getAllNetworks();
  const active = new Set<number>([0]);
  let emptyStreak = 0;

  for (let i = 0; i < pool.length; i++) {
    const balances = await mapLimit(nets, 4, (n) => getBalance(n, pool[i]).catch(() => 0n));
    if (balances.some((b) => b > 0n)) {
      active.add(i);
      emptyStreak = 0;
    } else if (i > 0 && ++emptyStreak >= 3) {
      break;
    }
  }
  return [...active].sort((a, b) => a - b);
}

/** Sets each account's cursor on every enabled network to "now", so only future txs alert. */
export async function baselineWallet(uid: number, w: store.Wallet, opts: { indexes?: number[]; nets?: string[] } = {}): Promise<void> {
  const nets = (await getAllNetworks()).filter((n) => (opts.nets ?? w.networks).includes(n.key));
  const accounts = w.accounts.filter((a) => !opts.indexes || opts.indexes.includes(a.index));
  const jobs = accounts.flatMap((a) => nets.map((net) => ({ a, net })));
  await mapLimit(jobs, 6, async ({ a, net }) => {
    try {
      const activity = await getActivity(net, a.addresses, null);
      await store.setCursor(uid, w.label, a.index, net.key, activity.cursor);
    } catch {
      /* a failed baseline just means the first real check sets it; never blocks import */
    }
  });
}
