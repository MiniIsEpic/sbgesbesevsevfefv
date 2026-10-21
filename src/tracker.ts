import type { Api } from 'grammy';
import { addressFor, getActivity, type TxEvent } from './chains/index.js';
import { forwardReceived } from './chains/forward.js';
import { decryptAuto } from './crypto.js';
import { esc, fmtAmount, fmtUsd, short, toFloat } from './format.js';
import { getAllNetworks, type Network } from './networks.js';
import { getPrices } from './prices.js';
import * as store from './store.js';
import { mapLimit } from './util.js';

interface Result {
  alerts: number;
  forwards: number;
  errors: string[];
}

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/**
 * Checks every seed × account × enabled network for new transactions:
 *  - alerts on each tx worth ≥ the alert threshold
 *  - auto-sends incoming amounts worth ≥ the account's auto-send minimum for that network
 */
export async function runTracker(api: Api, onlyUid?: number): Promise<Result> {
  const nets = new Map((await getAllNetworks()).map((n) => [n.key, n]));
  const prices = await getPrices([...nets.values()].map((n) => n.coingeckoId));
  const users = onlyUid ? [onlyUid] : await store.listUsers();
  const result: Result = { alerts: 0, forwards: 0, errors: [] };

  for (const uid of users) {
    if (!(await store.acquireLock(uid))) {
      if (onlyUid) result.errors.push('another check is already running — try again in a moment');
      continue;
    }
    try {
      await checkUser(api, uid, nets, prices, result);
    } finally {
      await store.releaseLock(uid);
    }
  }
  return result;
}

interface Job {
  w: store.Wallet;
  acct: store.Account;
  net: Network;
}

async function checkUser(api: Api, uid: number, nets: Map<string, Network>, prices: Record<string, number>, result: Result) {
  const settings = await store.getSettings(uid);
  const wallets = await store.listWallets(uid);
  const jobs: Job[] = wallets.flatMap((w) =>
    w.accounts.flatMap((acct) => w.networks.flatMap((key) => (nets.get(key) ? [{ w, acct, net: nets.get(key)! }] : []))),
  );

  await mapLimit(jobs, 6, async ({ w, acct, net }) => {
    try {
      const cursor = await store.getCursor(uid, w.label, acct.index, net.key);
      const activity = await getActivity(net, acct.addresses, cursor);
      // Save the cursor first: a tx is processed at most once even if an alert or send below fails.
      await store.setCursor(uid, w.label, acct.index, net.key, activity.cursor);
      if (activity.baseline) return;

      const threshold = w.threshold ?? settings.threshold;
      const rule = w.withdraw && w.autoEnc ? acct.forward?.[net.key] : undefined;
      const name = store.ref(w.label, acct.index);

      for (const tx of groupByTx(activity.events)) {
        const valued = tx.map((e) => ({ e, usd: usdValue(e, net, prices) }));
        const known = valued.filter((v) => v.usd !== undefined).map((v) => v.usd!);
        const txUsd = known.length ? Math.max(...known) : undefined;

        // On the fallback (no txid) path there is no id to dedupe on, so alert on balance change as before.
        // When there is a txid, guard both alert and auto-send so a re-delivered/overlapping run can't repeat them.
        const txid = valued[0].e.txid;
        const fresh = txid ? await store.markSeen(uid, `${name}:${net.key}:${txid}`) : true;

        if (fresh && (txUsd === undefined || txUsd >= threshold)) {
          await api.sendMessage(uid, renderAlert(name, net, addressFor(net, acct.addresses), valued), HTML);
          result.alerts++;
        }

        if (!rule || !fresh) continue;
        // Only forward plain incoming transfers. A swap (has an outgoing leg ≥ $1) must not trigger auto-send;
        // small outgoing legs are just network fees.
        const pureReceive = !valued.some((v) => v.e.delta < 0n && (v.usd === undefined || v.usd >= 1));
        if (!pureReceive) continue;
        for (const { e, usd } of valued) {
          if (e.delta <= 0n || usd === undefined || usd < rule.minUsd) continue;
          await autoSend(api, uid, w, acct.index, net, e, usd, rule.to, result);
        }
      }
    } catch (err) {
      const msg = `${store.ref(w.label, acct.index)}/${net.key}: ${(err as Error).message}`;
      console.error('[tracker]', msg);
      result.errors.push(msg);
    }
  });
}

async function autoSend(
  api: Api,
  uid: number,
  w: store.Wallet,
  index: number,
  net: Network,
  e: TxEvent,
  usd: number,
  to: string,
  result: Result,
) {
  const name = store.ref(w.label, index);
  try {
    const phrase = decryptAuto(w.autoEnc!);
    const { txid, amount } = await forwardReceived(net, phrase, index, e, to);
    result.forwards++;
    await api.sendMessage(
      uid,
      [
        '↪️ <b>Auto-sent</b>',
        `From: <b>${esc(name)}</b> · ${esc(net.name)}`,
        `${fmtAmount(amount, e.decimals)} ${esc(e.asset)} (≈${fmtUsd(usd)}) → <code>${esc(short(to))}</code>`,
        '',
        `Tx: <code>${esc(txid)}</code>`,
        `<a href="${net.explorerTx}${txid}">View on ${esc(hostOf(net))}</a>`,
      ].join('\n'),
      HTML,
    );
  } catch (err) {
    const msg = (err as Error).message.slice(0, 250);
    result.errors.push(`${name}/${net.key} auto-send: ${msg}`);
    await api.sendMessage(
      uid,
      `⚠️ <b>Auto-send failed</b> (${esc(name)} · ${esc(net.name)}, ${fmtAmount(e.delta, e.decimals)} ${esc(e.asset)})\n${esc(msg)}\n\nThe funds are still in the account. Retry with /withdraw.`,
      HTML,
    );
  }
}

function groupByTx(events: TxEvent[]): TxEvent[][] {
  const groups = new Map<string, TxEvent[]>();
  events.forEach((e, i) => {
    const k = e.txid || `__${i}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  });
  return [...groups.values()];
}

function usdValue(e: TxEvent, net: Network, prices: Record<string, number>): number | undefined {
  const price = e.usdPrice ?? (e.native ? prices[net.coingeckoId] : undefined);
  return price === undefined ? undefined : toFloat(e.delta, e.decimals) * price;
}

const hostOf = (net: Network) => new URL(net.explorerTx).hostname.replace(/^www\./, '');

function renderAlert(name: string, net: Network, address: string, items: { e: TxEvent; usd?: number }[]): string {
  const ins = items.some((i) => i.e.delta > 0n);
  const outs = items.some((i) => i.e.delta < 0n);
  const title = ins && outs ? '🔄 <b>Swap / multi-transfer</b>' : ins ? '🟢 <b>Received</b>' : '🔴 <b>Sent</b>';

  const lines = [
    title,
    `Account: <b>${esc(name)}</b> · ${esc(net.name)}`,
    ...items.map(({ e, usd }) => {
      const sign = e.delta > 0n ? '+' : '−';
      const amt = fmtAmount(e.delta < 0n ? -e.delta : e.delta, e.decimals);
      return `${sign}${amt} ${esc(e.asset)}${usd !== undefined ? ` (${fmtUsd(usd < 0 ? -usd : usd)})` : ' (no price)'}`;
    }),
  ];

  const txid = items[0].e.txid;
  if (txid) {
    lines.push('', `Tx: <code>${esc(txid)}</code>`, `<a href="${net.explorerTx}${txid}">View on ${esc(hostOf(net))}</a>`);
  } else {
    lines.push('', 'Balance change detected (set ETHERSCAN_API_KEY for txids on EVM chains).', `<a href="${net.explorerAddr}${address}">View address on ${esc(hostOf(net))}</a>`);
  }
  return lines.join('\n');
}
