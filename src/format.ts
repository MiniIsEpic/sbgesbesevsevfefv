import { formatUnits, parseUnits } from 'ethers';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

export function fmtAmount(v: bigint, decimals: number, dp = 6): string {
  const neg = v < 0n;
  const [i, f = ''] = formatUnits(neg ? -v : v, decimals).split('.');
  const frac = f.slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${Number(i).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

export function toFloat(v: bigint, decimals: number): number {
  return Number(formatUnits(v < 0n ? -v : v, decimals));
}

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseAmount(s: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Amount must be a positive number like 0.5');
  return parseUnits(s, decimals);
}
