import type { Addresses } from '../derive.js';
import type { Network } from '../networks.js';
import { btcActivity, btcBalance, btcSend, btcValidAddress } from './btc.js';
import { evmActivity, evmBalance, evmSend, evmValidAddress } from './evm.js';
import { solActivity, solBalance, solSend, solValidAddress } from './sol.js';
import type { Activity, Amount, Sent } from './types.js';

export type { Activity, Amount, Sent, TxEvent } from './types.js';

export const addressFor = (net: Network, a: Addresses) => (net.kind === 'evm' ? a.evm : net.kind === 'sol' ? a.sol : a.btc);

export function getBalance(net: Network, a: Addresses): Promise<bigint> {
  const addr = addressFor(net, a);
  return net.kind === 'evm' ? evmBalance(net, addr) : net.kind === 'sol' ? solBalance(net, addr) : btcBalance(net, addr);
}

export function getActivity(net: Network, a: Addresses, cursor: string | null): Promise<Activity> {
  const addr = addressFor(net, a);
  return net.kind === 'evm' ? evmActivity(net, addr, cursor) : net.kind === 'sol' ? solActivity(net, addr, cursor) : btcActivity(net, addr, cursor);
}

export function isValidAddress(net: Network, to: string): boolean {
  return net.kind === 'evm' ? evmValidAddress(to) : net.kind === 'sol' ? solValidAddress(to) : btcValidAddress(to);
}

export function sendNative(net: Network, phrase: string, index: number, to: string, amount: Amount): Promise<Sent> {
  return net.kind === 'evm'
    ? evmSend(net, phrase, index, to, amount)
    : net.kind === 'sol'
      ? solSend(net, phrase, index, to, amount)
      : btcSend(net, phrase, index, to, amount);
}
