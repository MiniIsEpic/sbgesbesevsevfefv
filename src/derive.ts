import { createHmac } from 'node:crypto';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { Wallet as EvmWallet, hexlify } from 'ethers';
import { Keypair } from '@solana/web3.js';

/** Accounts 0..19 per seed are derived at import, so accounts can be added later without the seed. */
export const MAX_ACCOUNTS = 20;

/**
 * Account i of a seed, matching how wallet apps add "Account 2, 3…":
 *   EVM  m/44'/60'/0'/0/i   – MetaMask, Rabby, Trust
 *   SOL  m/44'/501'/i'/0'   – Phantom, Solflare, Backpack
 *   BTC  m/84'/0'/i'/0/0    – native SegWit (bc1q…), first receive address of account i
 */
export const pathsFor = (i: number) => ({
  evm: `m/44'/60'/0'/0/${i}`,
  sol: `m/44'/501'/${i}'/0'`,
  btc: `m/84'/0'/${i}'/0/0`,
});

export interface Addresses {
  evm: string;
  sol: string;
  btc: string;
}

export const normalizePhrase = (s: string) => s.trim().toLowerCase().split(/\s+/).join(' ');
export const isValidPhrase = (p: string) => validateMnemonic(p, wordlist);

const masterOf = (phrase: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(phrase));

/** SLIP-0010 ed25519 derivation (all levels hardened). */
function slip10Ed25519(seed: Uint8Array, indexes: number[]): Buffer {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);
  for (const index of indexes) {
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    I = createHmac('sha512', chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return Buffer.from(key);
}

function evmFrom(master: HDKey, i: number): EvmWallet {
  const k = master.derive(pathsFor(i).evm);
  if (!k.privateKey) throw new Error('EVM derivation failed');
  return new EvmWallet(hexlify(k.privateKey));
}

function solFrom(seed: Uint8Array, i: number): Keypair {
  return Keypair.fromSeed(slip10Ed25519(seed, [44, 501, i, 0]));
}

function btcFrom(master: HDKey, i: number) {
  const node = master.derive(pathsFor(i).btc);
  if (!node.privateKey || !node.publicKey) throw new Error('BTC derivation failed');
  const address = btc.p2wpkh(node.publicKey).address;
  if (!address) throw new Error('BTC address derivation failed');
  return { privateKey: node.privateKey, publicKey: node.publicKey, address };
}

export const evmWallet = (phrase: string, i = 0) => evmFrom(masterOf(phrase), i);
export const solKeypair = (phrase: string, i = 0) => solFrom(mnemonicToSeedSync(phrase), i);
export const btcKey = (phrase: string, i = 0) => btcFrom(masterOf(phrase), i);

/** Addresses for several account indexes; the seed is computed once. */
export function deriveMany(phrase: string, indexes: number[]): Addresses[] {
  const seed = mnemonicToSeedSync(phrase);
  const master = HDKey.fromMasterSeed(seed);
  return indexes.map((i) => ({
    evm: evmFrom(master, i).address,
    sol: solFrom(seed, i).publicKey.toBase58(),
    btc: btcFrom(master, i).address,
  }));
}

export const deriveAddresses = (phrase: string, i = 0) => deriveMany(phrase, [i])[0];
