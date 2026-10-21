import { JsonRpcProvider, getAddress, id, isAddress, zeroPadValue, type Log } from 'ethers';
import { evmWallet } from '../derive.js';
import type { Network } from '../networks.js';
import { sleep } from '../util.js';
import type { Activity, Amount, Sent, TxEvent } from './types.js';

const providers = new Map<string, JsonRpcProvider>();
export function provider(net: Network): JsonRpcProvider {
  let p = providers.get(net.key);
  if (!p) {
    p = new JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true });
    providers.set(net.key, p);
  }
  return p;
}

export const evmBalance = (net: Network, address: string) => provider(net).getBalance(address);
export const evmValidAddress = (a: string) => isAddress(a);

// ---------- activity ----------
// With ETHERSCAN_API_KEY: full per-transaction tracking via Etherscan API v2 (one key, many chains).
// Without it: USDC/USDT transfers are read from RPC logs (with txid); native coin falls back to balance changes.

interface EsTx {
  hash: string;
  blockNumber: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
  contractAddress?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

// Etherscan's free tier allows ~5 calls/sec. Many wallets × chains × 3 calls in parallel got rate-limited
// and made EVM chains fail every run. Calls now go out one at a time, 250ms apart, with one retry.
const ES_GAP_MS = 250;
let esQueue: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = esQueue.then(fn);
  esQueue = run.catch(() => {}).then(() => sleep(ES_GAP_MS));
  return run;
}

async function etherscan(chainId: number, params: Record<string, string>, retry = true): Promise<EsTx[]> {
  const q = new URLSearchParams({ chainid: String(chainId), apikey: process.env.ETHERSCAN_API_KEY!, ...params });
  const json = await throttled(async () => {
    const res = await fetch(`https://api.etherscan.io/v2/api?${q}`, { signal: AbortSignal.timeout(10000) });
    return (await res.json()) as { status: string; message: string; result: unknown };
  });
  if (Array.isArray(json.result)) return json.result as EsTx[];
  if (json.message?.startsWith('No transactions')) return [];
  const reason = typeof json.result === 'string' ? json.result : json.message;
  if (retry && /rate limit/i.test(reason)) {
    await sleep(1100);
    return etherscan(chainId, params, false);
  }
  throw new Error(`Etherscan: ${reason}`);
}

export async function evmActivity(net: Network, address: string, cursor: string | null): Promise<Activity> {
  if (!process.env.ETHERSCAN_API_KEY || !net.chainId) return rpcActivity(net, address, cursor);

  if (cursor === null || !cursor.startsWith('blk:')) {
    const latest = await provider(net).getBlockNumber();
    return { events: [], cursor: `blk:${latest}`, baseline: true };
  }

  const from = Number(cursor.slice(4)) + 1;
  const range = { address, startblock: String(from), endblock: '99999999', sort: 'asc', page: '1', offset: '100' };
  const normal = await etherscan(net.chainId, { module: 'account', action: 'txlist', ...range });
  const internal = await etherscan(net.chainId, { module: 'account', action: 'txlistinternal', ...range });
  const tokens = await etherscan(net.chainId, { module: 'account', action: 'tokentx', ...range });

  const me = address.toLowerCase();
  const events: TxEvent[] = [];
  let maxBlock = from - 1;
  const signed = (t: EsTx, v: bigint) => (t.to?.toLowerCase() === me ? v : t.from?.toLowerCase() === me ? -v : 0n);

  for (const t of [...normal, ...internal]) {
    maxBlock = Math.max(maxBlock, Number(t.blockNumber));
    if (t.isError === '1') continue;
    if (t.to?.toLowerCase() === me && t.from?.toLowerCase() === me) continue; // self-send
    const delta = signed(t, BigInt(t.value));
    if (delta !== 0n) events.push({ txid: t.hash, asset: net.symbol, decimals: net.decimals, delta, native: true });
  }
  for (const t of tokens) {
    maxBlock = Math.max(maxBlock, Number(t.blockNumber));
    const stable = net.stables?.[t.contractAddress?.toLowerCase() ?? ''];
    if (!stable) continue; // unknown tokens ignored to avoid scam-airdrop spam
    const delta = signed(t, BigInt(t.value));
    if (delta !== 0n)
      events.push({ txid: t.hash, asset: stable.symbol, decimals: stable.decimals, delta, usdPrice: 1, native: false, token: t.contractAddress!.toLowerCase() });
  }
  return { events, cursor: `blk:${maxBlock}` };
}

const TRANSFER = id('Transfer(address,address,uint256)');
/** Max blocks scanned per check (public RPCs cap eth_getLogs ranges). Plenty at 1–2 min intervals. */
const MAX_LOG_RANGE = Number(process.env.EVM_MAX_LOG_RANGE ?? 5000);

/** No-indexer mode. Cursor format: "rpc:<lastBlock>:<nativeBalance>". */
async function rpcActivity(net: Network, address: string, cursor: string | null): Promise<Activity> {
  const p = provider(net);
  const [latest, bal] = await Promise.all([p.getBlockNumber(), p.getBalance(address)]);
  const next = `rpc:${latest}:${bal}`;
  if (cursor === null || !cursor.startsWith('rpc:')) return { events: [], cursor: next, baseline: true };

  const [, lastBlock, prevBal] = cursor.split(':');
  const fromBlock = Math.max(Number(lastBlock) + 1, latest - MAX_LOG_RANGE);
  const events: TxEvent[] = [];

  const tokens = Object.keys(net.stables ?? {});
  if (tokens.length && fromBlock <= latest) {
    const me = zeroPadValue(address, 32);
    const range = { address: tokens, fromBlock, toBlock: latest };
    const [incoming, outgoing] = await Promise.all([
      p.getLogs({ ...range, topics: [TRANSFER, null, me] }),
      p.getLogs({ ...range, topics: [TRANSFER, me] }),
    ]);
    const push = (log: Log, sign: 1n | -1n) => {
      const stable = net.stables![log.address.toLowerCase()];
      const value = BigInt(log.data);
      if (stable && value > 0n)
        events.push({ txid: log.transactionHash, asset: stable.symbol, decimals: stable.decimals, delta: sign * value, usdPrice: 1, native: false, token: log.address.toLowerCase() });
    };
    incoming.forEach((l) => push(l, 1n));
    outgoing.filter((l) => l.topics[2] !== me).forEach((l) => push(l, -1n)); // skip self-transfers
  }

  const delta = bal - BigInt(prevBal);
  if (delta !== 0n) events.push({ txid: '', asset: net.symbol, decimals: net.decimals, delta, native: true });
  return { events, cursor: next };
}

// ---------- sending ----------
export async function evmSend(net: Network, phrase: string, index: number, to: string, amount: Amount): Promise<Sent> {
  const p = provider(net);
  const wallet = evmWallet(phrase, index).connect(p);
  const dest = getAddress(to);

  if (amount !== 'max') {
    const tx = await wallet.sendTransaction({ to: dest, value: amount });
    return { txid: tx.hash, amount };
  }

  // "max": balance minus gas, with a 30% buffer (L2s also charge an L1 data fee).
  const [bal, fee, gasLimit] = await Promise.all([
    p.getBalance(wallet.address),
    p.getFeeData(),
    p.estimateGas({ from: wallet.address, to: dest, value: 1n }),
  ]);
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  if (!gasPrice) throw new Error('Could not fetch gas price');
  const value = bal - (gasLimit * gasPrice * 13n) / 10n;
  if (value <= 0n) throw new Error('Balance too low to cover gas');
  const tx = await wallet.sendTransaction({ to: dest, value, gasLimit });
  return { txid: tx.hash, amount: value };
}
