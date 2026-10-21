import * as btc from '@scure/btc-signer';
import { btcKey } from '../derive.js';
import type { Network } from '../networks.js';
import type { Activity, Amount, Sent, TxEvent } from './types.js';

const DUST = 546n;
export const BTC_FEE_RESERVE = 5_000n; // sats

async function api<T>(net: Network, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${net.rpc}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`BTC API ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

interface Stats { funded_txo_sum: number; spent_txo_sum: number }
interface EsploraTx {
  txid: string;
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

export async function btcBalance(net: Network, address: string): Promise<bigint> {
  const j = await api<{ chain_stats: Stats; mempool_stats: Stats }>(net, `/address/${address}`);
  const sum = (s: Stats) => BigInt(s.funded_txo_sum) - BigInt(s.spent_txo_sum);
  return sum(j.chain_stats) + sum(j.mempool_stats);
}

export function btcValidAddress(a: string): boolean {
  try {
    btc.Address(btc.NETWORK).decode(a);
    return true;
  } catch {
    return false;
  }
}

export async function btcActivity(net: Network, address: string, cursor: string | null): Promise<Activity> {
  const txs = await api<EsploraTx[]>(net, `/address/${address}/txs`); // newest first
  if (cursor === null) return { events: [], cursor: txs[0]?.txid ?? 'none', baseline: true };

  const fresh: EsploraTx[] = [];
  for (const t of txs) {
    if (t.txid === cursor) break;
    fresh.push(t);
  }
  const events: TxEvent[] = fresh.reverse().flatMap((t) => {
    const received = t.vout.filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + BigInt(o.value), 0n);
    const spent = t.vin.filter((i) => i.prevout?.scriptpubkey_address === address).reduce((s, i) => s + BigInt(i.prevout!.value), 0n);
    const delta = received - spent;
    return delta === 0n ? [] : [{ txid: t.txid, asset: net.symbol, decimals: net.decimals, delta, native: true }];
  });
  return { events, cursor: txs[0]?.txid ?? cursor };
}

export async function btcSend(net: Network, phrase: string, index: number, to: string, amount: Amount): Promise<Sent> {
  const key = btcKey(phrase, index);
  const utxos = await api<{ txid: string; vout: number; value: number }[]>(net, `/address/${key.address}/utxo`);
  if (!utxos.length) throw new Error('No spendable BTC');
  const fees = await api<{ halfHourFee: number }>(net, '/v1/fees/recommended');
  const feeRate = BigInt(Math.max(1, Math.ceil(fees.halfHourFee)));

  const script = btc.p2wpkh(key.publicKey).script;
  const tx = new btc.Transaction();
  let total = 0n;
  for (const u of utxos) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) } });
    total += BigInt(u.value);
  }
  const vbytes = (outputs: number) => BigInt(11 + 68 * utxos.length + 31 * outputs);

  let sent: bigint;
  if (amount === 'max') {
    sent = total - vbytes(1) * feeRate;
    if (sent < DUST) throw new Error('Balance too low to cover the fee');
    tx.addOutputAddress(to, sent);
  } else {
    if (amount < DUST) throw new Error('Amount is below the BTC dust limit (546 sats)');
    const change = total - amount - vbytes(2) * feeRate;
    if (change < 0n) throw new Error('Insufficient BTC for amount + fee');
    sent = amount;
    tx.addOutputAddress(to, amount);
    if (change >= DUST) tx.addOutputAddress(key.address, change);
  }
  tx.sign(key.privateKey);
  tx.finalize();
  const txid = (await api<string>(net, '/tx', { method: 'POST', body: tx.hex })).trim();
  return { txid, amount: sent };
}
