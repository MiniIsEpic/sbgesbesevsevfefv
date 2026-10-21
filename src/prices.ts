import * as store from './store.js';

const CACHE_KEY = 'prices:last';

/**
 * USD prices from CoinGecko. If CoinGecko is down or rate-limits, falls back to the last good prices
 * (up to 6h old) so thresholds and auto-send keep working instead of alerting on every dust tx.
 */
export async function getPrices(ids: string[]): Promise<Record<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const cached = (await store.getJson<Record<string, number>>(CACHE_KEY).catch(() => null)) ?? {};

  const key = process.env.COINGECKO_API_KEY;
  const url = `https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=${encodeURIComponent(unique.join(','))}`;
  try {
    const res = await fetch(url, { headers: key ? { 'x-cg-demo-api-key': key } : {}, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return cached;
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const fresh: Record<string, number> = { ...cached };
    for (const [id, v] of Object.entries(json)) if (typeof v.usd === 'number') fresh[id] = v.usd;
    await store.setJson(CACHE_KEY, fresh, 6 * 3600).catch(() => {});
    return fresh;
  } catch {
    return cached;
  }
}
