import { Connection, PublicKey, SystemProgram, Transaction, type ParsedTransactionWithMeta } from '@solana/web3.js';
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

export async function solActivity(net: Network, address: string, cursor: string | null): Promise<Activity> {
  const c = solConn(net);
  const owner = new PublicKey(address);

  if (cursor === null) {
    const [latest] = await c.getSignaturesForAddress(owner, { limit: 1 });
    return { events: [], cursor: latest?.signature ?? 'none', baseline: true };
  }

  const sigs = await c.getSignaturesForAddress(owner, cursor === 'none' ? { limit: 25 } : { until: cursor, limit: 25 });
  if (!sigs.length) return { events: [], cursor };

  const ordered = [...sigs].reverse(); // oldest first
  const txs = await mapLimit(ordered, 5, (s) =>
    s.err ? Promise.resolve(null) : c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
  );

  // A just-landed tx can be listed before its details are ready. Stop at that point and pick it up
  // next run, rather than advancing the cursor past it and missing it permanently.
  const events: TxEvent[] = [];
  let newCursor = cursor;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const tx = txs[i];
    if (!s.err && !tx) break;
    if (tx?.meta) events.push(...parseSolTx(net, address, s.signature, tx));
    newCursor = s.signature;
  }
  return { events, cursor: newCursor };
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
