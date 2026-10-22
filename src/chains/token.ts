import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Contract, getAddress } from 'ethers';
import { evmWallet, solKeypair } from '../derive.js';
import type { Network } from '../networks.js';
import { provider } from './evm.js';
import { solConn } from './sol.js';
import type { Sent } from './types.js';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/** Token (USDC/USDT) balance of `owner`, in base units. `token` is a contract (EVM) or mint (SOL). */
export async function tokenBalance(net: Network, owner: string, token: string): Promise<bigint> {
  if (net.kind === 'evm') {
    const c = new Contract(token, ERC20, provider(net));
    return BigInt((await c.balanceOf(owner)).toString());
  }
  if (net.kind === 'sol') {
    const ata = getAssociatedTokenAddressSync(new PublicKey(token), new PublicKey(owner));
    try {
      const b = await solConn(net).getTokenAccountBalance(ata);
      return BigInt(b.value.amount);
    } catch {
      return 0n; // no token account yet = zero
    }
  }
  return 0n; // BTC has no tokens
}

/** Sends `amount` base units of a token from account `index` to `to`. */
export async function sendToken(net: Network, phrase: string, index: number, token: string, decimals: number, amount: bigint, to: string): Promise<Sent> {
  if (amount <= 0n) throw new Error('Amount must be greater than zero');

  if (net.kind === 'evm') {
    const w = evmWallet(phrase, index).connect(provider(net));
    const erc20 = new Contract(token, ERC20, w);
    const tx = await erc20.transfer(getAddress(to), amount);
    return { txid: tx.hash as string, amount };
  }

  if (net.kind === 'sol') {
    const c = solConn(net);
    const kp = solKeypair(phrase, index);
    const mint = new PublicKey(token);
    const dest = new PublicKey(to);
    const fromAta = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const toAta = getAssociatedTokenAddressSync(mint, dest, true);
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
      // Creates the destination's token account if missing (~0.002 SOL rent, paid by this account).
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, toAta, dest, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, kp.publicKey, amount, decimals),
    );
    tx.sign(kp);
    return { txid: await c.sendRawTransaction(tx.serialize(), { maxRetries: 5 }), amount };
  }

  throw new Error(`Token withdrawals aren't supported on ${net.name}`);
}

/** Reverse-lookup a stablecoin on a network by symbol (e.g. "USDC"). Returns its contract/mint + decimals. */
export function stableBySymbol(net: Network, symbol: string): { token: string; decimals: number } | null {
  for (const [addr, meta] of Object.entries(net.stables ?? {})) {
    if (meta.symbol.toUpperCase() === symbol.toUpperCase()) return { token: addr, decimals: meta.decimals };
  }
  return null;
}
