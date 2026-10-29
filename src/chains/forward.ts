import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Contract, getAddress } from 'ethers';
import { btcKey, evmWallet, solKeypair } from '../derive.js';
import type { Network } from '../networks.js';
import { btcBalance, btcSend, BTC_FEE_RESERVE } from './btc.js';
import { evmSend, provider } from './evm.js';
import { solConn, solSend, SOL_FEE, SOL_RENT_MIN } from './sol.js';
import { tokenBalance } from './token.js';
import type { Sent, TxEvent } from './types.js';

/**
 * Forwards the amount received in `e`, from account `index` of this seed, to `to`.
 * Native coins: forwards the received amount (minus fees if the balance is too tight).
 * USDC/USDT: forwards the exact token amount (the account needs a little native coin for gas).
 */
export async function forwardReceived(net: Network, phrase: string, index: number, e: TxEvent, to: string): Promise<Sent> {
  if (e.delta <= 0n) throw new Error('Only incoming amounts are forwarded');
  return e.native ? forwardNative(net, phrase, index, e.delta, to) : forwardToken(net, phrase, index, e, to);
}

async function forwardNative(net: Network, phrase: string, index: number, received: bigint, to: string): Promise<Sent> {
  if (net.kind === 'sol') {
    const bal = BigInt(await solConn(net).getBalance(solKeypair(phrase, index).publicKey));
    let amount = received < bal - SOL_FEE ? received : bal - SOL_FEE;
    const left = bal - SOL_FEE - amount;
    if (left > 0n && left < SOL_RENT_MIN) amount = bal - SOL_FEE; // leftover below rent → sweep all
    if (amount <= 0n) throw new Error('Balance too low to cover the fee');
    return solSend(net, phrase, index, to, amount);
  }

  if (net.kind === 'evm') {
    const p = provider(net);
    const w = evmWallet(phrase, index);
    const [bal, fee] = await Promise.all([p.getBalance(w.address), p.getFeeData()]);
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const reserve = (21000n * gasPrice * 13n) / 10n;
    // Not enough left to pay gas on top of the received amount: send everything minus gas.
    return evmSend(net, phrase, index, to, received + reserve > bal ? 'max' : received);
  }

  // BTC
  const bal = await btcBalance(net, btcKey(phrase, index).address);
  return btcSend(net, phrase, index, to, received + BTC_FEE_RESERVE >= bal ? 'max' : received);
}

async function forwardToken(net: Network, phrase: string, index: number, e: TxEvent, to: string): Promise<Sent> {
  if (!e.token) throw new Error('Unknown token');

  if (net.kind === 'evm') {
    const w = evmWallet(phrase, index).connect(provider(net));
    // Send the current balance, not the historical received amount, so it can't fail on "insufficient
    // funds" when the balance differs slightly, and it sweeps any token already sitting in the account.
    const bal = await tokenBalance(net, w.address, e.token);
    const amount = bal < e.delta ? bal : e.delta;
    if (amount <= 0n) throw new Error('No token balance available to forward (already moved?)');
    const erc20 = new Contract(e.token, ['function transfer(address to, uint256 amount) returns (bool)'], w);
    const tx = await erc20.transfer(getAddress(to), amount);
    return { txid: tx.hash as string, amount };
  }

  if (net.kind === 'sol') {
    const c = solConn(net);
    const kp = solKeypair(phrase, index);
    const mint = new PublicKey(e.token);
    const dest = new PublicKey(to);
    const fromAta = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const toAta = getAssociatedTokenAddressSync(mint, dest, true);
    // Use the live balance of this account's token account, capped at the received amount.
    const bal = await tokenBalance(net, kp.publicKey.toBase58(), e.token);
    const amount = bal < e.delta ? bal : e.delta;
    if (amount <= 0n) throw new Error('No USDC/USDT balance available to forward (already moved?)');
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
      // Creates the destination token account if missing (~0.002 SOL rent, paid by this account).
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, toAta, dest, mint),
      createTransferCheckedInstruction(fromAta, mint, toAta, kp.publicKey, amount, e.decimals),
    );
    tx.sign(kp);
    const txid = await c.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    return { txid, amount };
  }

  throw new Error(`Token forwarding isn't supported on ${net.name}`);
}
