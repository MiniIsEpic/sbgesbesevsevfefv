import { Connection, PublicKey, SystemProgram, Transaction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { solKeypair } from '../derive.js';
import type { Network } from '../networks.js';
import { mapLimit } from '../util.js';
import type { Activity, Amount, Sent, TxEvent } from './types.js';

export const SOL_FEE = 5000n;
/** Rent-exempt minimum for a plain system account (~0.00089 SOL). */
export const SOL_RENT_MIN = 890_880n;

export const solConn = (net: Network) => new Connection(net.rpc, 'confirmed');

export async function solBalance(net: Network, address: string): Promise<bigint> {
  return BigInt(await solConn(net).getBalance(new PublicKey(address)));
}

export function solValidAddress(a: string): boolean {
  try {
    return new PublicKey(a).toBase58() === a;
  } catch {
    return false;
  }
}

/**
 * Watches the owner wallet AND its USDC/USDT token accounts (ATAs). Incoming SPL transfers only
 * touch the recipient's token account, not the owner wallet, so querying the wallet alone misses them.
 * The cursor is a JSON map { "<source>": "<last signature>" } — one per watched address.
 */
export async function solActivity(net: Network, address: string, cursor: string | null): Promise<Activity> {
  const c = solConn(net);
  const owner = new PublicKey(address);

  const sources: { key: string; pk: PublicKey }[] = [{ key: 'owner', pk: owner }];
  for (const mint of Object.keys(net.stables ?? {})) {
    try {
      sources.push({ key: mint, pk: getAssociatedTokenAddressSync(new PublicKey(mint), owner) });
    } catch {
      /* skip a mint that can't derive an ATA */
    }
  }

  // Baseline: record the latest signature for every watched address, emit nothing.
  if (cursor === null) {
    const next: Record<string, string> = {};
    await Promise.all(
      sources.map(async (s) => {
        const [latest] = await c.getSignaturesForAddress(s.pk, { limit: 1 }).catch(() => []);
        next[s.key] = latest?.signature ?? 'none';
      }),
    );
    return { events: [], cursor: JSON.stringify(next), baseline: true };
  }

  // Parse the stored cursor. Legacy cursors were a bare owner signature string.
  let cmap: Record<string, string> = {};
  try {
    const p = JSON.parse(cursor);
    cmap = p && typeof p === 'object' ? (p as Record<string, string>) : { owner: cursor };
  } catch {
    cmap = { owner: cursor };
  }

  const next: Record<string, string> = { ...cmap };
  const seen = new Map<string, number>(); // signature -> blockTime, dedupes txs touching several sources
  for (const s of sources) {
    const until = cmap[s.key];
    // A source we've never tracked before (a token account added by this upgrade, or a newly-added mint)
    // is baselined silently — record its latest signature and emit nothing, so we don't replay old history.
    if (until === undefined) {
      const [latest] = await c.getSignaturesForAddress(s.pk, { limit: 1 }).catch(() => []);
      next[s.key] = latest?.signature ?? 'none';
      continue;
    }
    let sigs;
    try {
      sigs = await c.getSignaturesForAddress(s.pk, until !== 'none' ? { until, limit: 25 } : { limit: 25 });
    } catch {
      continue;
    }
    if (sigs.length) next[s.key] = sigs[0].signature;
    for (const si of sigs) if (!si.err) seen.set(si.signature, si.blockTime ?? 0);
  }

  if (seen.size === 0) return { events: [], cursor: JSON.stringify(next) };

  const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]); // oldest first
  const txs = await mapLimit(ordered, 5, (sig) =>
    c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null),
  );
  const events: TxEvent[] = [];
  ordered.forEach((sig, i) => {
    const tx = txs[i];
    if (tx?.meta) events.push(...parseSolTx(net, address, sig, tx));
  });
  return { events, cursor: JSON.stringify(next) };
}

function parseSolTx(net: Network, address: string, sig: string, tx: ParsedTransactionWithMeta): TxEvent[] {
  const meta = tx.meta!;
  const out: TxEvent[] = [];

  // Native SOL: this account's balance change across the transaction.
  const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
  if (idx >= 0) {
    const delta = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
    if (delta !== 0n) out.push({ txid: sig, asset: net.symbol, decimals: net.decimals, delta, native: true });
  }

  // SPL stablecoins owned by this account.
  const byMint = new Map<string, bigint>();
  for (const b of meta.preTokenBalances ?? [])
    if (b.owner === address) byMint.set(b.mint, (byMint.get(b.mint) ?? 0n) - BigInt(b.uiTokenAmount.amount));
  for (const b of meta.postTokenBalances ?? [])
    if (b.owner === address) byMint.set(b.mint, (byMint.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  for (const [mint, delta] of byMint) {
    const stable = net.stables?.[mint];
    if (stable && delta !== 0n)
      out.push({ txid: sig, asset: stable.symbol, decimals: stable.decimals, delta, usdPrice: 1, native: false, token: mint });
  }
  return out;
}

export async function solSend(net: Network, phrase: string, index: number, to: string, amount: Amount): Promise<Sent> {
  const c = solConn(net);
  const kp = solKeypair(phrase, index);
  const bal = BigInt(await c.getBalance(kp.publicKey));
  const lamports = amount === 'max' ? bal - SOL_FEE : amount;
  if (lamports <= 0n) throw new Error('Balance too low to cover the network fee');
  if (amount !== 'max' && lamports + SOL_FEE > bal) throw new Error('Insufficient SOL for amount + fee');

  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }),
  );
  tx.sign(kp);
  const txid = await c.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  return { txid, amount: lamports };
}
