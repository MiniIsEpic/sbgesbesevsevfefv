import * as store from './store.js';

export type NetKind = 'evm' | 'sol' | 'btc';

export interface Network {
  key: string;
  name: string;
  kind: NetKind;
  symbol: string;
  decimals: number;
  coingeckoId: string;
  rpc: string;
  chainId?: number;
  explorerTx: string;
  explorerAddr: string;
  /** Stablecoins priced at $1 so token transfers can be alerted on. Unknown tokens are ignored (avoids airdrop spam). */
  stables?: Record<string, { symbol: string; decimals: number }>;
  custom?: boolean;
}

const env = (k: string, fallback: string) => process.env[k] || fallback;
const usd = (symbol: string, decimals = 6) => ({ symbol, decimals });

export const BUILTIN: Network[] = [
  {
    key: 'sol', name: 'Solana', kind: 'sol', symbol: 'SOL', decimals: 9, coingeckoId: 'solana',
    rpc: env('RPC_SOL', 'https://api.mainnet-beta.solana.com'),
    explorerTx: 'https://solscan.io/tx/', explorerAddr: 'https://solscan.io/account/',
    stables: {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: usd('USDC'),
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McNe8BenwNYB: usd('USDT'),
    },
  },
  {
    key: 'btc', name: 'Bitcoin', kind: 'btc', symbol: 'BTC', decimals: 8, coingeckoId: 'bitcoin',
    rpc: env('BTC_API', 'https://mempool.space/api'),
    explorerTx: 'https://mempool.space/tx/', explorerAddr: 'https://mempool.space/address/',
  },
  {
    key: 'eth', name: 'Ethereum', kind: 'evm', chainId: 1, symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum',
    rpc: env('RPC_ETH', 'https://ethereum-rpc.publicnode.com'),
    explorerTx: 'https://etherscan.io/tx/', explorerAddr: 'https://etherscan.io/address/',
    stables: {
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': usd('USDC'),
      '0xdac17f958d2ee523a2206206994597c13d831ec7': usd('USDT'),
    },
  },
  {
    key: 'base', name: 'Base', kind: 'evm', chainId: 8453, symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum',
    rpc: env('RPC_BASE', 'https://mainnet.base.org'),
    explorerTx: 'https://basescan.org/tx/', explorerAddr: 'https://basescan.org/address/',
    stables: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': usd('USDC') },
  },
  {
    key: 'arb', name: 'Arbitrum', kind: 'evm', chainId: 42161, symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum',
    rpc: env('RPC_ARB', 'https://arb1.arbitrum.io/rpc'),
    explorerTx: 'https://arbiscan.io/tx/', explorerAddr: 'https://arbiscan.io/address/',
    stables: {
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': usd('USDC'),
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': usd('USDT'),
    },
  },
  {
    key: 'op', name: 'Optimism', kind: 'evm', chainId: 10, symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum',
    rpc: env('RPC_OP', 'https://mainnet.optimism.io'),
    explorerTx: 'https://optimistic.etherscan.io/tx/', explorerAddr: 'https://optimistic.etherscan.io/address/',
    stables: { '0x0b2c639c533813f4aa9d7837caf62653d097ff85': usd('USDC') },
  },
  {
    key: 'polygon', name: 'Polygon', kind: 'evm', chainId: 137, symbol: 'POL', decimals: 18, coingeckoId: 'polygon-ecosystem-token',
    rpc: env('RPC_POLYGON', 'https://polygon-rpc.com'),
    explorerTx: 'https://polygonscan.com/tx/', explorerAddr: 'https://polygonscan.com/address/',
    stables: { '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': usd('USDC') },
  },
  {
    key: 'bsc', name: 'BNB Chain', kind: 'evm', chainId: 56, symbol: 'BNB', decimals: 18, coingeckoId: 'binancecoin',
    rpc: env('RPC_BSC', 'https://bsc-dataseed.bnbchain.org'),
    explorerTx: 'https://bscscan.com/tx/', explorerAddr: 'https://bscscan.com/address/',
    stables: {
      '0x55d398326f99059ff775485246999027b3197955': usd('USDT', 18),
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': usd('USDC', 18),
    },
  },
];

export const isBuiltin = (key: string) => BUILTIN.some((n) => n.key === key);

export async function getAllNetworks(): Promise<Network[]> {
  return [...BUILTIN, ...(await store.listCustomNetworks())];
}

export async function getNetwork(key: string): Promise<Network | undefined> {
  return (await getAllNetworks()).find((n) => n.key === key.toLowerCase());
}
