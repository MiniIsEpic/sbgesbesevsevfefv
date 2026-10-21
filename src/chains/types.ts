/** One asset movement inside a transaction, from the tracked account's point of view. */
export interface TxEvent {
  /** Empty when the chain is in balance-change fallback mode (no tx history API). */
  txid: string;
  asset: string;
  decimals: number;
  /** Signed, in base units: positive = received, negative = sent. */
  delta: bigint;
  /** Fixed USD price (stablecoins). Otherwise priced via the network's coingeckoId. */
  usdPrice?: number;
  /** True if this is the network's native coin (priced via coingeckoId). */
  native: boolean;
  /** Token mint (Solana) or contract (EVM) for non-native assets. */
  token?: string;
}

export interface Activity {
  events: TxEvent[];
  /** Opaque checkpoint stored between runs. */
  cursor: string;
  /** True when this run only set the starting point (first run): no alerts. */
  baseline?: boolean;
}

export type Amount = bigint | 'max';

export interface Sent {
  txid: string;
  /** Amount actually sent, in base units. */
  amount: bigint;
}
