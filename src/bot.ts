import { Bot, InlineKeyboard, type Context } from 'grammy';
import { JsonRpcProvider } from 'ethers';
import { addressFor, getBalance, isValidAddress, sendNative } from './chains/index.js';
import { baselineWallet, buildPool, discoverAccounts } from './accounts.js';
import { allowedUsers, botToken, withdrawLimitUsd } from './config.js';
import { decryptSeed, encryptAuto, encryptSeed, hashPin, verifyPin } from './crypto.js';
import { isValidPhrase, MAX_ACCOUNTS, normalizePhrase } from './derive.js';
import { esc, fmtAmount, fmtUsd, parseAmount, short, toFloat } from './format.js';
import { BUILTIN, getAllNetworks, getNetwork, isBuiltin, type Network } from './networks.js';
import { getPrices } from './prices.js';
import { clearBalanceCache } from './balances.js';
import * as menu from './menu.js';
import type { View } from './menu.js';
import * as store from './store.js';
import { runTracker } from './tracker.js';
import { mapLimit } from './util.js';

const LABEL_RE = /^[a-z0-9_-]{1,20}$/;
const NETKEY_RE = /^[a-z0-9_-]{2,20}$/;
const MIN_PIN = 6;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 60 * 1000;
const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

const HELP = `<b>Wallet tracker bot</b>

📂 /menu — open the button menu (balances per account + total)

Each seed is a group; its accounts are <code>label.0</code>, <code>label.1</code>… (like Account 1, 2… in your wallet app). Commands that take &lt;acct&gt; accept <code>label</code> (= <code>label.0</code>) or <code>label.N</code>.

<b>Setup</b>
/setpin · /changepin — PIN that encrypts seeds and signs sends
/import &lt;label&gt; — add one named seed (or use 📂 /menu → Import to paste several at once)
/remove &lt;label&gt; — delete a seed and all its accounts

<b>Accounts</b>
/wallets — seeds, accounts, addresses
/accounts &lt;label&gt; — list/add accounts of a seed
/addaccount &lt;label&gt; &lt;index&gt; — track another account (0–${MAX_ACCOUNTS - 1})
/delaccount &lt;label&gt; &lt;index&gt;

<b>Tracking</b>
/balances [acct] · /networks
/enable &lt;label&gt; &lt;net,net|all&gt; · /disable &lt;label&gt; &lt;net,net|all&gt;
/threshold &lt;usd&gt; [label] · /check

<b>Withdrawals</b>
/whitelist &lt;label&gt; on|off
/withdraw &lt;acct&gt; &lt;net&gt; &lt;amount|max&gt; &lt;address&gt;

<b>Auto-send</b>
/autosend &lt;acct&gt; &lt;net&gt; &lt;minUsd&gt; &lt;address&gt; · /autosend · /autosend off &lt;acct&gt; [net]

<b>Custom EVM networks</b>
/addnetwork &lt;key&gt; &lt;chainId&gt; &lt;symbol&gt; &lt;coingeckoId&gt; &lt;rpcUrl&gt; &lt;explorerUrl&gt; · /delnetwork &lt;key&gt;

/cancel — abort what's in progress`;

const uid = (ctx: Context) => ctx.from!.id;
const args = (ctx: Context) => String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);

/** Resolves "label" or "label.N" to the seed and account. */
async function resolveAccount(id: number, token: string): Promise<{ w: store.Wallet; acct: store.Account } | null> {
  const [label, idxRaw] = token.toLowerCase().split('.');
  const w = await store.getWallet(id, label);
  if (!w) return null;
  const index = idxRaw === undefined ? 0 : Number(idxRaw);
  const acct = w.accounts.find((a) => a.index === index);
  return acct ? { w, acct } : null;
}

const CONFIRM_HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/** Validates a withdrawal and shows the Confirm/Cancel buttons. Shared by the /withdraw command and the button flow. */
async function presentWithdraw(ctx: Context, acctRaw: string, netKey: string, amtRaw: string, to: string): Promise<void> {
  const id = ctx.from!.id;
  const res = await resolveAccount(id, acctRaw);
  if (!res) return void (await ctx.reply(`No account "${acctRaw}".`));
  const { w, acct } = res;
  if (!w.withdraw) return void (await ctx.reply(`Withdrawals are blocked for ${w.label}.`));
  const net = await getNetwork(netKey);
  if (!net) return void (await ctx.reply(`Unknown network "${netKey}".`));
  if (!w.networks.includes(net.key)) return void (await ctx.reply(`${w.label} isn't tracking ${net.key}.`));
  if (!isValidAddress(net, to)) return void (await ctx.reply(`That isn't a valid ${net.name} address. Start again from the menu.`));
  const from = addressFor(net, acct.addresses);
  if (to.toLowerCase() === from.toLowerCase()) return void (await ctx.reply('Destination is the same account.'));

  let bal: bigint;
  try { bal = await getBalance(net, acct.addresses); } catch (e) { return void (await ctx.reply(`Could not fetch balance: ${(e as Error).message.slice(0, 120)}`)); }
  let amount: bigint | 'max';
  try { amount = amtRaw.toLowerCase() === 'max' ? 'max' : parseAmount(amtRaw, net.decimals); } catch (e) { return void (await ctx.reply((e as Error).message)); }
  if (amount !== 'max' && (amount <= 0n || amount > bal)) return void (await ctx.reply(`Insufficient balance: ${fmtAmount(bal, net.decimals)} ${net.symbol} available.`));
  if (amount === 'max' && bal === 0n) return void (await ctx.reply('Balance is zero.'));

  const shown = amount === 'max' ? bal : amount;
  const price = (await getPrices([net.coingeckoId]))[net.coingeckoId];
  const usd = price !== undefined ? toFloat(shown, net.decimals) * price : undefined;
  const limit = withdrawLimitUsd();
  if (limit !== undefined) {
    if (usd === undefined) return void (await ctx.reply('Price unavailable, so the limit cannot be checked. Try again shortly.'));
    if (usd > limit) return void (await ctx.reply(`Above your per-withdrawal limit of ${fmtUsd(limit)}.`));
  }

  await store.setWithdraw(id, { label: w.label, index: acct.index, net: net.key, amount: amount === 'max' ? 'max' : amount.toString(), to, createdAt: Date.now() });
  const amtText = amount === 'max' ? `ALL (≈${fmtAmount(bal, net.decimals)} ${net.symbol} minus fees)` : `${fmtAmount(amount, net.decimals)} ${net.symbol}`;
  await ctx.reply(
    [
      '<b>Confirm withdrawal</b>',
      `From: <b>${esc(store.ref(w.label, acct.index))}</b> (${short(from)})`,
      `Network: ${esc(net.name)}`,
      `Amount: ${esc(amtText)}${usd !== undefined ? ` ≈ ${fmtUsd(usd)}` : ''}`,
      `To: <code>${esc(to)}</code>`,
      '',
      '⚠️ Check the address character by character. Transactions cannot be reversed. Expires in 5 minutes.',
    ].join('\n'),
    { ...CONFIRM_HTML, reply_markup: new InlineKeyboard().text('✅ Confirm', 'wd:ok').text('❌ Cancel', 'wd:no') },
  );
}

/** Validates an auto-send rule and shows the Confirm/Cancel buttons. Shared by command and button flow. */
async function presentAutosend(ctx: Context, acctRaw: string, netKey: string, minRaw: string, to: string): Promise<void> {
  const id = ctx.from!.id;
  const res = await resolveAccount(id, acctRaw);
  if (!res) return void (await ctx.reply(`No account "${acctRaw}".`));
  const { w, acct } = res;
  if (!w.withdraw) return void (await ctx.reply(`Turn on withdrawals for ${w.label} first (Security).`));
  const net = await getNetwork(netKey);
  if (!net) return void (await ctx.reply(`Unknown network "${netKey}".`));
  if (!w.networks.includes(net.key)) return void (await ctx.reply(`${w.label} isn't tracking ${net.key}.`));
  const minUsd = Number(minRaw.replace('$', ''));
  if (!Number.isFinite(minUsd) || minUsd <= 0) return void (await ctx.reply('The minimum must be a number above 0.'));
  if (!isValidAddress(net, to)) return void (await ctx.reply(`That isn't a valid ${net.name} address. Start again from the menu.`));
  if (to.toLowerCase() === addressFor(net, acct.addresses).toLowerCase()) return void (await ctx.reply("Destination can't be the same account."));

  await store.setAutosend(id, { label: w.label, index: acct.index, net: net.key, minUsd, to });
  await ctx.reply(
    [
      '<b>Confirm auto-send rule</b>',
      `Account: <b>${esc(store.ref(w.label, acct.index))}</b> · ${esc(net.name)}`,
      `When an incoming tx is worth ≥ ${fmtUsd(minUsd)}, forward that amount (${esc(net.symbol)}${net.stables ? ', USDC/USDT' : ''}) to:`,
      `<code>${esc(to)}</code>`,
      '',
      '⚠️ This runs without asking each time, and the server keeps an extra encrypted copy of this seed it can unlock without your PIN.',
    ].join('\n'),
    { ...CONFIRM_HTML, reply_markup: new InlineKeyboard().text('✅ Confirm', 'as:ok').text('❌ Cancel', 'as:no') },
  );
}

async function replyLong(ctx: Context, text: string) {
  const chunks: string[] = [];
  let cur = '';
  for (const block of text.split('\n\n')) {
    if (cur && cur.length + block.length + 2 > 3900) {
      chunks.push(cur);
      cur = block;
    } else cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) await ctx.reply(c, HTML);
}

async function deleteQuietly(ctx: Context) {
  try {
    await ctx.deleteMessage();
  } catch {
    await ctx.reply('⚠️ I could not delete your message. Delete it manually — it contains secrets.');
  }
}

/** Checks the PIN with lockout after repeated failures. Replies on failure. */
async function checkPin(ctx: Context, pin: string): Promise<boolean> {
  const id = uid(ctx);
  const s = await store.getSettings(id);
  if (!s.pinHash || !s.pinSalt) {
    await ctx.reply('No PIN set. Use /setpin first.');
    return false;
  }
  if (s.lockedUntil > Date.now()) {
    const mins = Math.ceil((s.lockedUntil - Date.now()) / 60000);
    await ctx.reply(`🔒 Too many wrong PINs. Locked for ${mins} more minute(s).`);
    return false;
  }
  if (verifyPin(pin, s.pinSalt, s.pinHash)) {
    if (s.failed) await store.saveSettings(id, { ...s, failed: 0 });
    return true;
  }
  const failed = s.failed + 1;
  if (failed >= MAX_FAILS) {
    await store.saveSettings(id, { ...s, failed: 0, lockedUntil: Date.now() + LOCK_MS });
    await ctx.reply('🔒 Wrong PIN. Too many attempts — locked for 1 hour.');
  } else {
    await store.saveSettings(id, { ...s, failed });
    await ctx.reply(`❌ Wrong PIN (${failed}/${MAX_FAILS}).`);
  }
  await store.clearPending(id);
  await store.clearWithdraw(id);
  await store.clearAutosend(id);
  return false;
}

function parseNetList(arg: string | undefined, all: Network[]): string[] | string {
  if (!arg) return 'Give one or more network keys (comma-separated) or "all". See /networks.';
  if (arg === 'all') return all.map((n) => n.key);
  const keys = arg.toLowerCase().split(',').filter(Boolean);
  const unknown = keys.filter((k) => !all.some((n) => n.key === k));
  return unknown.length ? `Unknown network(s): ${unknown.join(', ')}. See /networks.` : keys;
}

export function createBot() {
  const bot = new Bot(botToken());

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowedUsers().includes(id)) return;
    if (ctx.chat && ctx.chat.type !== 'private') return;
    await next();
  });

  bot.command('help', (ctx) => ctx.reply(HELP, HTML));

  const showView = (ctx: Context, v: View) => ctx.reply(v.text, { ...HTML, reply_markup: v.keyboard });

  // /start and /menu open the button menu.
  bot.command(['start', 'menu'], async (ctx) => {
    await showView(ctx, await menu.homeView(uid(ctx)));
  });

  // ---- view helpers ----
  async function editView(ctx: Context, v: View) {
    try {
      await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.keyboard });
    } catch {
      /* "message is not modified" or message too old — ignore */
    }
  }
  /** Start a text flow: answer the tap, then prompt for input. */
  async function ask(ctx: Context, pending: store.Pending, text: string) {
    await store.setPending(uid(ctx), pending, 300);
    await ctx.answerCallbackQuery();
    await ctx.reply(text, HTML);
  }

  // ---- navigation ----
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery('nav:home', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.homeView(uid(ctx))); });
  bot.callbackQuery('nav:help', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, menu.helpView()); });
  bot.callbackQuery('nav:wd', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.withdrawPickView(uid(ctx))); });
  bot.callbackQuery('nav:as', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.autosendPickView(uid(ctx))); });
  bot.callbackQuery('nav:alerts', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.alertsView(uid(ctx))); });
  bot.callbackQuery('nav:sec', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.securityView(uid(ctx))); });
  bot.callbackQuery('nav:net', async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.networksView(uid(ctx))); });
  bot.callbackQuery(/^nav:wallets:(-?\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.walletsView(uid(ctx), Number(ctx.match[1]))); });
  bot.callbackQuery(/^wal:r:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Refreshing…' });
    await clearBalanceCache(uid(ctx));
    await editView(ctx, await menu.walletsView(uid(ctx), Number(ctx.match[1]), true));
  });
  bot.callbackQuery(/^acct:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.accountView(uid(ctx), ctx.match[1])); });

  // ---- import (button flow) ----
  bot.callbackQuery('flow:import', async (ctx) => {
    if (!(await store.getSettings(uid(ctx))).pinHash) {
      await ctx.answerCallbackQuery({ text: 'Set a PIN first', show_alert: true });
      return editView(ctx, await menu.homeView(uid(ctx)));
    }
    await ask(
      ctx,
      { kind: 'import-multi' },
      [
        'Paste your seed phrase(s), <b>one per line</b>, and put your <b>PIN on the last line</b>:',
        '',
        '<code>word1 … word12</code>',
        '<code>word1 … word12</code>',
        '<code>YOURPIN</code>',
        '',
        'One seed is fine too (one line + your PIN line). I delete the message immediately. /cancel to stop.',
      ].join('\n'),
    );
  });

  // ---- alerts ----
  bot.callbackQuery(/^th:(\d+)$/, async (ctx) => {
    const id = uid(ctx);
    const s = await store.getSettings(id);
    await store.saveSettings(id, { ...s, threshold: Number(ctx.match[1]) });
    await ctx.answerCallbackQuery({ text: `Alert threshold set to $${ctx.match[1]}` });
    await editView(ctx, await menu.alertsView(id));
  });
  bot.callbackQuery('th:custom', (ctx) => ask(ctx, { kind: 'th-custom' }, 'Send the alert threshold in USD (e.g. <code>15</code>).'));

  // ---- security: PIN + whitelist toggle ----
  bot.callbackQuery('sec:setpin', (ctx) =>
    ask(ctx, { kind: 'setpin' }, `Send your new PIN <b>twice</b>, separated by a space:\n<code>myPin123 myPin123</code>\n\nAt least ${MIN_PIN} characters. I'll delete the message.`));
  bot.callbackQuery('sec:changepin', (ctx) =>
    ask(ctx, { kind: 'changepin' }, 'Send your <b>old</b> and <b>new</b> PIN separated by a space:\n<code>oldPin newPin</code>'));
  bot.callbackQuery(/^wl:([a-z0-9_-]+)$/, async (ctx) => {
    const id = uid(ctx);
    const w = await store.getWallet(id, ctx.match[1]);
    if (!w) return ctx.answerCallbackQuery({ text: 'Seed gone' });
    w.withdraw = !w.withdraw;
    await store.saveWallet(id, w);
    await ctx.answerCallbackQuery({ text: `Withdrawals ${w.withdraw ? 'enabled' : 'blocked'} for ${w.label}` });
    await editView(ctx, await menu.securityView(id));
  });

  // ---- networks toggle ----
  bot.callbackQuery(/^net:w:([a-z0-9_-]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.seedNetworksView(uid(ctx), ctx.match[1])); });
  bot.callbackQuery(/^net:t:([a-z0-9_-]+):([a-z0-9_-]+)$/, async (ctx) => {
    const id = uid(ctx);
    const [, label, key] = ctx.match;
    const w = await store.getWallet(id, label);
    if (!w) return ctx.answerCallbackQuery({ text: 'Seed gone' });
    if (w.networks.includes(key)) {
      w.networks = w.networks.filter((k) => k !== key);
      await store.saveWallet(id, w);
      for (const a of w.accounts) await store.deleteCursors(id, w.label, { index: a.index, net: key });
      await ctx.answerCallbackQuery({ text: `${key} off` });
    } else {
      w.networks = [...w.networks, key];
      await store.saveWallet(id, w);
      await baselineWallet(id, w, { nets: [key] });
      await ctx.answerCallbackQuery({ text: `${key} on` });
    }
    await editView(ctx, await menu.seedNetworksView(id, label));
  });

  // ---- withdraw (button flow) ----
  bot.callbackQuery(/^wd:a:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.pickNetworkView(uid(ctx), 'wd', ctx.match[1])); });
  bot.callbackQuery(/^wd:n:(.+):([a-z0-9_-]+)$/, async (ctx) => {
    const [, ref, net] = ctx.match;
    const [label, idx] = ref.split('.');
    await ask(ctx, { kind: 'wd-amount', label, index: Number(idx), net }, `Send the amount of <b>${esc(net.toUpperCase())}</b> to withdraw from <b>${esc(ref)}</b>, or type <code>max</code>.`);
  });

  // ---- auto-send (button flow) ----
  bot.callbackQuery(/^as:a:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await editView(ctx, await menu.pickNetworkView(uid(ctx), 'as', ctx.match[1])); });
  bot.callbackQuery(/^as:n:(.+):([a-z0-9_-]+)$/, async (ctx) => {
    const [, ref, net] = ctx.match;
    const [label, idx] = ref.split('.');
    await ask(ctx, { kind: 'as-min', label, index: Number(idx), net }, `Auto-send on <b>${esc(ref)}</b> · <b>${esc(net)}</b>:\nsend the <b>minimum USD</b> value that should trigger a forward (e.g. <code>10</code>).`);
  });

  bot.command('cancel', async (ctx) => {
    const id = uid(ctx);
    await Promise.all([store.clearPending(id), store.clearWithdraw(id), store.clearAutosend(id)]);
    await ctx.reply('Cancelled.');
  });

  // ---------- PIN ----------
  bot.command('setpin', async (ctx) => {
    if ((await store.getSettings(uid(ctx))).pinHash) return ctx.reply('A PIN is already set. Use /changepin.');
    await store.setPending(uid(ctx), { kind: 'setpin' });
    await ctx.reply(
      `Send your new PIN <b>twice</b>, separated by a space:\n<code>myPin123 myPin123</code>\n\nAt least ${MIN_PIN} characters, no spaces. Longer is safer. I'll delete the message.`,
      HTML,
    );
  });

  bot.command('changepin', async (ctx) => {
    await store.setPending(uid(ctx), { kind: 'changepin' });
    await ctx.reply('Send your <b>old</b> and <b>new</b> PIN separated by a space:\n<code>oldPin newPin</code>', HTML);
  });

  // ---------- import / remove ----------
  bot.command('import', async (ctx) => {
    const id = uid(ctx);
    const label = (args(ctx)[0] ?? '').toLowerCase();
    if (!LABEL_RE.test(label)) return ctx.reply('Usage: /import <label>   (letters, numbers, - or _, max 20)');
    if (!(await store.getSettings(id)).pinHash) return ctx.reply('Set a PIN first with /setpin.');
    if (await store.getWallet(id, label)) return ctx.reply(`A seed named "${label}" already exists.`);
    await store.setPending(id, { kind: 'import', label });
    await ctx.reply(
      `Send your seed phrase followed by your PIN as the last word, in <b>one</b> message:\n<code>word1 word2 … word12 YOURPIN</code>\n\nI'll delete it immediately and find your active accounts. /cancel to abort.`,
      HTML,
    );
  });

  bot.command('remove', async (ctx) => {
    const label = (args(ctx)[0] ?? '').toLowerCase();
    if (!(await store.getWallet(uid(ctx), label))) return ctx.reply('Usage: /remove <label>');
    await ctx.reply(`Delete seed <b>${esc(label)}</b> and all its accounts? (On-chain funds are not affected.)`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('🗑 Delete', `rm:${label}:ok`).text('Cancel', `rm:${label}:no`),
    });
  });

  bot.callbackQuery(/^rm:([a-z0-9_-]+):(ok|no)$/, async (ctx) => {
    const [, label, action] = ctx.match;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (action === 'no') return ctx.reply('Kept.');
    await store.deleteWallet(uid(ctx), label);
    await ctx.reply(`Deleted ${label}.`);
  });

  // ---------- accounts ----------
  bot.command('wallets', async (ctx) => {
    const id = uid(ctx);
    const [wallets, s] = await Promise.all([store.listWallets(id), store.getSettings(id)]);
    if (!wallets.length) return ctx.reply('No seeds yet. Use /import <label>.');
    const body = wallets.map((w) => {
      const head = `<b>${esc(w.label)}</b> · ${w.accounts.length} account(s) · withdrawals ${w.withdraw ? '✅' : '⛔'} · alert ≥ ${fmtUsd(w.threshold ?? s.threshold)}\nNetworks: ${w.networks.join(', ') || '(none)'}`;
      const accts = w.accounts.map((a) => {
        const fwd = Object.entries(a.forward ?? {}).map(([k, r]) => `\n  ↪️ ${k} ≥ ${fmtUsd(r.minUsd)} → ${esc(short(r.to))}${w.withdraw ? '' : ' (paused)'}`).join('');
        return `• <b>${esc(store.ref(w.label, a.index))}</b>\n  EVM <code>${a.addresses.evm}</code>\n  SOL <code>${a.addresses.sol}</code>\n  BTC <code>${a.addresses.btc}</code>${fwd}`;
      });
      return [head, ...accts].join('\n');
    });
    await replyLong(ctx, body.join('\n\n'));
  });

  bot.command('accounts', async (ctx) => {
    const label = (args(ctx)[0] ?? '').toLowerCase();
    const w = label ? await store.getWallet(uid(ctx), label) : null;
    if (!w) return ctx.reply('Usage: /accounts <label>');
    const tracked = new Set(w.accounts.map((a) => a.index));
    const lines = w.accounts.map((a) => `• <b>${esc(store.ref(w.label, a.index))}</b> — SOL <code>${esc(short(a.addresses.sol))}</code> · EVM <code>${esc(short(a.addresses.evm))}</code>`);
    const untracked = [...Array(MAX_ACCOUNTS).keys()].filter((i) => !tracked.has(i)).slice(0, 5);
    await ctx.reply(
      [`Accounts of <b>${esc(w.label)}</b>:`, ...lines, '', `Add another with /addaccount ${w.label} <index>${untracked.length ? ` (e.g. ${untracked[0]})` : ''}`].join('\n'),
      HTML,
    );
  });

  bot.command('addaccount', async (ctx) => {
    const id = uid(ctx);
    const [labelRaw, idxRaw] = args(ctx);
    const w = labelRaw ? await store.getWallet(id, labelRaw.toLowerCase()) : null;
    if (!w) return ctx.reply('Usage: /addaccount <label> <index>');
    const index = Number(idxRaw);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) return ctx.reply(`Index must be 0–${MAX_ACCOUNTS - 1}.`);
    if (w.accounts.some((a) => a.index === index)) return ctx.reply(`${store.ref(w.label, index)} is already tracked.`);
    if (!w.pool[index]) return ctx.reply('That account index is unavailable. Re-import the seed to refresh.');
    w.accounts.push({ index, addresses: w.pool[index] });
    await store.saveWallet(id, w);
    await baselineWallet(id, w, { indexes: [index] });
    await ctx.reply(`✅ Now tracking <b>${esc(store.ref(w.label, index))}</b>\nSOL <code>${w.pool[index].sol}</code>\nEVM <code>${w.pool[index].evm}</code>`, HTML);
  });

  bot.command('delaccount', async (ctx) => {
    const id = uid(ctx);
    const [labelRaw, idxRaw] = args(ctx);
    const w = labelRaw ? await store.getWallet(id, labelRaw.toLowerCase()) : null;
    if (!w) return ctx.reply('Usage: /delaccount <label> <index>');
    const index = Number(idxRaw);
    if (w.accounts.length <= 1) return ctx.reply('A seed must keep at least one account. Use /remove to delete the whole seed.');
    if (!w.accounts.some((a) => a.index === index)) return ctx.reply(`${store.ref(w.label, index)} isn't tracked.`);
    w.accounts = w.accounts.filter((a) => a.index !== index);
    if (!store.hasForwardRules(w)) delete w.autoEnc;
    await store.saveWallet(id, w);
    await store.deleteCursors(id, w.label, { index });
    await ctx.reply(`Removed ${store.ref(w.label, index)} from tracking.`);
  });

  bot.command('balances', async (ctx) => {
    const id = uid(ctx);
    const filter = args(ctx)[0]?.toLowerCase();
    const wallets = await store.listWallets(id);
    const targets = wallets.flatMap((w) =>
      w.accounts
        .filter((a) => !filter || w.label === filter || store.ref(w.label, a.index) === filter)
        .map((a) => ({ w, a })),
    );
    if (!targets.length) return ctx.reply(filter ? `No account matching "${filter}".` : 'No seeds yet.');
    await ctx.reply('Fetching balances…');
    const nets = await getAllNetworks();
    const prices = await getPrices(nets.map((n) => n.coingeckoId));

    const sections = await mapLimit(targets, 4, async ({ w, a }) => {
      let total = 0;
      const rows = await mapLimit(
        nets.filter((n) => w.networks.includes(n.key)),
        4,
        async (n) => {
          try {
            const bal = await getBalance(n, a.addresses);
            if (bal === 0n) return null;
            const price = prices[n.coingeckoId];
            const usd = price !== undefined ? toFloat(bal, n.decimals) * price : undefined;
            if (usd) total += usd;
            return `${n.name}: ${fmtAmount(bal, n.decimals)} ${n.symbol}${usd !== undefined ? ` (${fmtUsd(usd)})` : ''}`;
          } catch (e) {
            return `⚠️ ${n.name}: ${esc((e as Error).message.slice(0, 80))}`;
          }
        },
      );
      const lines = rows.filter(Boolean);
      return `<b>${esc(store.ref(w.label, a.index))}</b> — ${fmtUsd(total)}\n${lines.length ? lines.join('\n') : '(empty)'}`;
    });
    await replyLong(ctx, `${sections.join('\n\n')}\n\n<i>Native coins only.</i>`);
  });

  // ---------- networks ----------
  bot.command('networks', async (ctx) => {
    const nets = await getAllNetworks();
    await ctx.reply(nets.map((n) => `<code>${n.key}</code> — ${esc(n.name)} (${esc(n.symbol)})${n.custom ? ' · custom' : ''}`).join('\n'), HTML);
  });

  const toggle = (enable: boolean) => async (ctx: Context) => {
    const id = uid(ctx);
    const [labelRaw, netArg] = args(ctx);
    const w = labelRaw ? await store.getWallet(id, labelRaw.toLowerCase()) : null;
    if (!w) return ctx.reply(`Usage: /${enable ? 'enable' : 'disable'} <label> <net,net|all>`);
    const keys = parseNetList(netArg, await getAllNetworks());
    if (typeof keys === 'string') return ctx.reply(keys);
    if (enable) {
      const added = keys.filter((k) => !w.networks.includes(k));
      w.networks = [...new Set([...w.networks, ...keys])];
      await store.saveWallet(id, w);
      await baselineWallet(id, w, { nets: added });
    } else {
      w.networks = w.networks.filter((k) => !keys.includes(k));
      for (const a of w.accounts) for (const k of keys) await store.deleteCursors(id, w.label, { index: a.index, net: k });
      await store.saveWallet(id, w);
    }
    await ctx.reply(`${w.label} now tracks: ${w.networks.join(', ') || '(none)'}`);
  };
  bot.command('enable', toggle(true));
  bot.command('disable', toggle(false));

  bot.command('addnetwork', async (ctx) => {
    const [key, chainIdRaw, symbol, coingeckoId, rpc, explorer] = args(ctx);
    if (!explorer)
      return ctx.reply('Usage: /addnetwork <key> <chainId> <symbol> <coingeckoId> <rpcUrl> <explorerUrl>\nExample: /addnetwork avax 43114 AVAX avalanche-2 https://api.avax.network/ext/bc/C/rpc https://snowtrace.io');
    const k = key.toLowerCase();
    const chainId = Number(chainIdRaw);
    if (!NETKEY_RE.test(k) || isBuiltin(k)) return ctx.reply('Invalid or reserved network key.');
    if (!Number.isInteger(chainId) || chainId <= 0) return ctx.reply('chainId must be a positive integer.');
    if (!/^https:\/\//.test(rpc) || !/^https:\/\//.test(explorer)) return ctx.reply('RPC and explorer must be https:// URLs.');
    try {
      const got = await new JsonRpcProvider(rpc).getNetwork();
      if (Number(got.chainId) !== chainId) return ctx.reply(`RPC reports chainId ${got.chainId}, not ${chainId}.`);
    } catch (e) {
      return ctx.reply(`Could not reach RPC: ${(e as Error).message.slice(0, 120)}`);
    }
    const base = explorer.replace(/\/+$/, '');
    await store.saveCustomNetwork({
      key: k, name: k.toUpperCase(), kind: 'evm', chainId, symbol: symbol.toUpperCase(), decimals: 18,
      coingeckoId, rpc, explorerTx: `${base}/tx/`, explorerAddr: `${base}/address/`, custom: true,
    });
    await ctx.reply(`Added ${k}. Turn it on with /enable <label> ${k}`);
  });

  bot.command('delnetwork', async (ctx) => {
    const id = uid(ctx);
    const k = (args(ctx)[0] ?? '').toLowerCase();
    if (!k || isBuiltin(k)) return ctx.reply('Usage: /delnetwork <custom key>  (built-in networks can be disabled per seed instead)');
    await store.deleteCustomNetwork(k);
    for (const w of await store.listWallets(id)) {
      if (w.networks.includes(k)) {
        w.networks = w.networks.filter((n) => n !== k);
        await store.saveWallet(id, w);
        await store.deleteCursors(id, w.label, { net: k });
      }
    }
    await ctx.reply(`Removed ${k}.`);
  });

  // ---------- alerts ----------
  bot.command('threshold', async (ctx) => {
    const id = uid(ctx);
    const [amtRaw, labelRaw] = args(ctx);
    const s = await store.getSettings(id);
    if (!amtRaw) return ctx.reply(`Global alert threshold: ${fmtUsd(s.threshold)}\nSet with /threshold <usd> [label]`);
    const usd = Number(amtRaw.replace('$', ''));
    if (!Number.isFinite(usd) || usd < 0) return ctx.reply('Threshold must be a number ≥ 0.');
    if (labelRaw) {
      const w = await store.getWallet(id, labelRaw.toLowerCase());
      if (!w) return ctx.reply(`No seed "${labelRaw}".`);
      w.threshold = usd;
      await store.saveWallet(id, w);
      return ctx.reply(`${w.label}: alerting on transactions ≥ ${fmtUsd(usd)}.`);
    }
    await store.saveSettings(id, { ...s, threshold: usd });
    await ctx.reply(`Global: alerting on transactions ≥ ${fmtUsd(usd)} (seeds with their own threshold keep it).`);
  });

  bot.command('check', async (ctx) => {
    await ctx.reply('Checking for new transactions…');
    const r = await runTracker(ctx.api, uid(ctx));
    const errs = r.errors.length ? `\n⚠️ ${r.errors.length} issue(s):\n${r.errors.slice(0, 5).map((e) => `• ${esc(e.slice(0, 150))}`).join('\n')}` : '';
    await ctx.reply(`Done — ${r.alerts} alert(s), ${r.forwards} auto-send(s).${errs}`, HTML);
  });

  // ---------- withdrawals ----------
  bot.command('whitelist', async (ctx) => {
    const id = uid(ctx);
    const [labelRaw, state] = args(ctx);
    const w = labelRaw ? await store.getWallet(id, labelRaw.toLowerCase()) : null;
    if (!w || !['on', 'off'].includes(state ?? '')) return ctx.reply('Usage: /whitelist <label> on|off');
    w.withdraw = state === 'on';
    await store.saveWallet(id, w);
    const paused = !w.withdraw && store.hasForwardRules(w) ? ' Auto-send rules are paused too.' : '';
    await ctx.reply(`Withdrawals from ${w.label}: ${w.withdraw ? '✅ allowed' : '⛔ blocked'}.${paused}`);
  });

  bot.command('withdraw', async (ctx) => {
    const id = uid(ctx);
    const parts = args(ctx);
    if (parts.length !== 4) return ctx.reply('Usage: /withdraw <acct> <net> <amount|max> <address>\nExample: /withdraw main sol 0.5 9xQe…  (or use /menu → Withdraw)');
    await presentWithdraw(ctx, parts[0], parts[1], parts[2], parts[3]);
  });

  bot.callbackQuery(/^wd:(ok|no)$/, async (ctx) => {
    const id = uid(ctx);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (ctx.match[1] === 'no') {
      await store.clearWithdraw(id);
      return ctx.reply('Withdrawal cancelled.');
    }
    if (!(await store.getWithdraw(id))) return ctx.reply('That withdrawal expired. Start again with /withdraw.');
    await store.setPending(id, { kind: 'withdraw-pin' });
    await ctx.reply('🔐 Send your PIN to sign and broadcast. /cancel to abort.');
  });

  // ---------- auto-send ----------
  bot.command('autosend', async (ctx) => {
    const id = uid(ctx);
    const parts = args(ctx);

    if (!parts.length) {
      const lines = (await store.listWallets(id)).flatMap((w) =>
        w.accounts.flatMap((a) => Object.entries(a.forward ?? {}).map(([k, r]) => `<b>${esc(store.ref(w.label, a.index))}</b> · ${k}: ≥ ${fmtUsd(r.minUsd)} → <code>${esc(r.to)}</code>${w.withdraw ? '' : ' (paused)'}`)),
      );
      return ctx.reply(lines.length ? lines.join('\n') : 'No auto-send rules. Usage: /autosend <acct> <net> <minUsd> <address>', HTML);
    }

    if (parts[0].toLowerCase() === 'off') {
      const res = parts[1] ? await resolveAccount(id, parts[1]) : null;
      if (!res) return ctx.reply('Usage: /autosend off <acct> [net]');
      const { w, acct } = res;
      const key = parts[2]?.toLowerCase();
      const forward = { ...(acct.forward ?? {}) };
      if (key) delete forward[key];
      else for (const k of Object.keys(forward)) delete forward[k];
      acct.forward = forward;
      if (!store.hasForwardRules(w)) delete w.autoEnc;
      await store.saveWallet(id, w);
      return ctx.reply(`Auto-send ${key ? `for ${key} ` : ''}turned off on ${store.ref(w.label, acct.index)}.${w.autoEnc ? '' : ' Its auto-send key copy was deleted.'}`);
    }

    if (parts.length !== 4) return ctx.reply('Usage: /autosend <acct> <net> <minUsd> <address>\nExample: /autosend main sol 10 9xQe…  (or use /menu → Auto-send)');
    await presentAutosend(ctx, parts[0], parts[1], parts[2], parts[3]);
  });

  bot.callbackQuery(/^as:(ok|no)$/, async (ctx) => {
    const id = uid(ctx);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (ctx.match[1] === 'no') {
      await store.clearAutosend(id);
      return ctx.reply('Cancelled.');
    }
    if (!(await store.getAutosend(id))) return ctx.reply('That request expired. Run /autosend again.');
    await store.setPending(id, { kind: 'autosend-pin' });
    await ctx.reply('🔐 Send your PIN to activate the rule. /cancel to abort.');
  });

  // ---------- free-text replies to pending prompts ----------
  bot.on('message:text', async (ctx) => {
    const id = uid(ctx);
    const pending = await store.getPending(id);
    if (!pending) return showView(ctx, await menu.homeView(id));
    // Only delete messages that carry a secret (seed or PIN); amounts/addresses are fine to keep.
    const SECRET = new Set(['setpin', 'changepin', 'import', 'import-multi', 'withdraw-pin', 'autosend-pin']);
    if (SECRET.has(pending.kind)) await deleteQuietly(ctx);
    const tokens = ctx.msg.text.trim().split(/\s+/);

    switch (pending.kind) {
      case 'import-label': {
        await store.clearPending(id);
        const label = (tokens[0] ?? '').toLowerCase();
        if (!LABEL_RE.test(label)) return ctx.reply('Name must be letters, numbers, - or _ (max 20). Tap ➕ Import to retry.');
        if (await store.getWallet(id, label)) return ctx.reply(`A seed named "${label}" already exists.`);
        await store.setPending(id, { kind: 'import', label }, 300);
        return ctx.reply(`Now send the <b>seed phrase</b> for "${esc(label)}" followed by your <b>PIN</b> as the last word:\n<code>word1 … word12 YOURPIN</code>\n\nI'll delete it immediately. /cancel to stop.`, HTML);
      }

      case 'wd-amount': {
        await store.setPending(id, { kind: 'wd-address', label: pending.label, index: pending.index, net: pending.net, amount: tokens[0] ?? '' }, 300);
        return ctx.reply('Now send the <b>destination address</b>.', HTML);
      }
      case 'wd-address': {
        await store.clearPending(id);
        await presentWithdraw(ctx, store.ref(pending.label, pending.index), pending.net, pending.amount, tokens[0] ?? '');
        return;
      }

      case 'as-min': {
        const minUsd = Number((tokens[0] ?? '').replace('$', ''));
        if (!Number.isFinite(minUsd) || minUsd <= 0) {
          await store.clearPending(id);
          return ctx.reply("That isn't a valid number. Tap ↪️ Auto-send to retry.");
        }
        await store.setPending(id, { kind: 'as-address', label: pending.label, index: pending.index, net: pending.net, minUsd }, 300);
        return ctx.reply('Now send the <b>destination address</b> to forward to.', HTML);
      }
      case 'as-address': {
        await store.clearPending(id);
        await presentAutosend(ctx, store.ref(pending.label, pending.index), pending.net, String(pending.minUsd), tokens[0] ?? '');
        return;
      }

      case 'th-custom': {
        await store.clearPending(id);
        const usd = Number((tokens[0] ?? '').replace('$', ''));
        if (!Number.isFinite(usd) || usd < 0) return ctx.reply('Threshold must be a number ≥ 0.');
        const s = await store.getSettings(id);
        await store.saveSettings(id, { ...s, threshold: usd });
        return showView(ctx, await menu.alertsView(id));
      }

      case 'setpin': {
        await store.clearPending(id);
        if (tokens.length !== 2 || tokens[0] !== tokens[1]) return ctx.reply("PINs didn't match. Try /setpin again.");
        if (tokens[0].length < MIN_PIN) return ctx.reply(`PIN must be at least ${MIN_PIN} characters. Try /setpin again.`);
        const s = await store.getSettings(id);
        await store.saveSettings(id, { ...s, ...hashPin(tokens[0]), failed: 0, lockedUntil: 0 });
        await ctx.reply('✅ PIN set.');
        return showView(ctx, await menu.homeView(id));
      }

      case 'changepin': {
        if (tokens.length !== 2) {
          await store.clearPending(id);
          return ctx.reply('Expected "<old> <new>". Try /changepin again.');
        }
        const [oldPin, newPin] = tokens;
        if (!(await checkPin(ctx, oldPin))) return;
        await store.clearPending(id);
        if (newPin.length < MIN_PIN) return ctx.reply(`New PIN must be at least ${MIN_PIN} characters.`);
        const wallets = await store.listWallets(id);
        for (const w of wallets) {
          const phrase = decryptSeed(w.enc, oldPin);
          w.enc = encryptSeed(phrase, newPin);
          if (w.autoEnc) w.autoEnc = encryptAuto(phrase); // auto copy is PIN-independent, but rewrap for consistency
          await store.saveWallet(id, w);
        }
        await store.saveSettings(id, { ...(await store.getSettings(id)), ...hashPin(newPin) });
        return ctx.reply(`✅ PIN changed and ${wallets.length} seed(s) re-encrypted.`);
      }

      case 'import': {
        const pin = tokens.pop() ?? '';
        const phrase = normalizePhrase(tokens.join(' '));
        if (!(await checkPin(ctx, pin))) return;
        await store.clearPending(id);
        if (!isValidPhrase(phrase)) return ctx.reply("That isn't a valid BIP-39 seed phrase (12/24 words, then your PIN). Try /import again.");

        const pool = buildPool(phrase);
        if ((await store.listWallets(id)).some((w) => w.pool[0]?.evm === pool[0].evm)) return ctx.reply('This seed is already imported.');
        await ctx.reply('Seed accepted. Scanning for active accounts…');
        let indexes: number[];
        try {
          indexes = await discoverAccounts(pool);
        } catch {
          indexes = [0]; // scan failed (RPC) — just track account 0; more can be added with /addaccount
        }
        const wallet: store.Wallet = {
          label: pending.label,
          pool,
          accounts: indexes.map((i) => ({ index: i, addresses: pool[i] })),
          enc: encryptSeed(phrase, pin),
          networks: BUILTIN.map((n) => n.key),
          withdraw: false,
          createdAt: Date.now(),
        };
        await store.saveWallet(id, wallet);
        await baselineWallet(id, wallet);
        const list = wallet.accounts.map((a) => `• <b>${esc(store.ref(wallet.label, a.index))}</b>  SOL <code>${esc(short(a.addresses.sol))}</code>  EVM <code>${esc(short(a.addresses.evm))}</code>`);
        await ctx.reply(
          [
            `✅ Imported <b>${esc(pending.label)}</b> with ${wallet.accounts.length} active account(s):`,
            ...list,
            '',
            'Check these match your wallet app. Tracking is live now.',
            'Withdrawals are <b>off</b> by default — enable them in 🛡️ Security.',
          ].join('\n'),
          HTML,
        );
        return showView(ctx, await menu.homeView(id));
      }

      case 'import-multi': {
        await store.clearPending(id);
        const raw = ctx.msg.text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (raw.length < 2) return ctx.reply('Paste at least one seed line and your PIN on the last line. Tap ➕ Import to retry.');
        const pin = raw.pop()!;
        if (!(await checkPin(ctx, pin))) return;
        const over = Math.max(0, raw.length - 10);
        const phrases = raw.slice(0, 10);
        const discover = phrases.length <= 3; // skip per-account discovery for big batches to stay within the function time limit

        const wallets = await store.listWallets(id);
        const seenEvm = new Set(wallets.map((w) => w.pool[0]?.evm));
        const taken = new Set(wallets.map((w) => w.label));
        let counter = 1;
        const nextLabel = () => {
          let l: string;
          do l = `seed${counter++}`;
          while (taken.has(l));
          taken.add(l);
          return l;
        };

        const added: string[] = [];
        const dup: number[] = [];
        const bad: number[] = [];
        for (let i = 0; i < phrases.length; i++) {
          const phrase = normalizePhrase(phrases[i]);
          if (!isValidPhrase(phrase)) { bad.push(i + 1); continue; }
          const pool = buildPool(phrase);
          if (seenEvm.has(pool[0].evm)) { dup.push(i + 1); continue; }
          seenEvm.add(pool[0].evm);
          let indexes = [0];
          if (discover) { try { indexes = await discoverAccounts(pool); } catch { indexes = [0]; } }
          const wallet: store.Wallet = {
            label: nextLabel(),
            pool,
            accounts: indexes.map((ix) => ({ index: ix, addresses: pool[ix] })),
            enc: encryptSeed(phrase, pin),
            networks: BUILTIN.map((n) => n.key),
            withdraw: false,
            createdAt: Date.now() + i,
          };
          await store.saveWallet(id, wallet);
          await baselineWallet(id, wallet);
          added.push(`<b>${esc(wallet.label)}</b> (${wallet.accounts.length} acct${wallet.accounts.length > 1 ? 's' : ''})`);
        }

        const out = [added.length ? `✅ Imported ${added.length} seed(s): ${added.join(', ')}` : '⚠️ Nothing imported.'];
        if (dup.length) out.push(`Skipped already-imported line(s): ${dup.join(', ')}`);
        if (bad.length) out.push(`Invalid seed on line(s): ${bad.join(', ')}`);
        if (over > 0) out.push(`Only the first 10 were processed — send the remaining ${over} in another batch.`);
        out.push('', 'Seeds are auto-named. Withdrawals are <b>off</b> by default (🛡️ Security).');
        await ctx.reply(out.join('\n'), HTML);
        return showView(ctx, await menu.homeView(id));
      }

      case 'autosend-pin': {
        const as = await store.getAutosend(id);
        if (!as) {
          await store.clearPending(id);
          return ctx.reply('That request expired. Run /autosend again.');
        }
        if (!(await checkPin(ctx, tokens[0] ?? ''))) return;
        await store.clearPending(id);
        await store.clearAutosend(id);
        const w = await store.getWallet(id, as.label);
        const acct = w?.accounts.find((a) => a.index === as.index);
        if (!w || !acct) return ctx.reply('Account no longer exists.');
        w.autoEnc ??= encryptAuto(decryptSeed(w.enc, tokens[0]));
        acct.forward = { ...(acct.forward ?? {}), [as.net]: { to: as.to, minUsd: as.minUsd } };
        await store.saveWallet(id, w);
        return ctx.reply(
          `✅ Auto-send on: ${store.ref(w.label, as.index)} · ${as.net}, incoming ≥ ${fmtUsd(as.minUsd)} → <code>${esc(as.to)}</code>\nTurn off with /autosend off ${store.ref(w.label, as.index)} ${as.net}`,
          HTML,
        );
      }

      case 'withdraw-pin': {
        const wd = await store.getWithdraw(id);
        if (!wd) {
          await store.clearPending(id);
          return ctx.reply('That withdrawal expired. Start again with /withdraw.');
        }
        if (!(await checkPin(ctx, tokens[0] ?? ''))) return;
        await store.clearPending(id);
        await store.clearWithdraw(id);

        const [w, net] = await Promise.all([store.getWallet(id, wd.label), getNetwork(wd.net)]);
        const acct = w?.accounts.find((a) => a.index === wd.index);
        if (!w || !net || !acct || !w.withdraw) return ctx.reply('Account or network no longer available.');
        await ctx.reply('Signing and broadcasting…');
        try {
          const phrase = decryptSeed(w.enc, tokens[0]);
          const { txid } = await sendNative(net, phrase, acct.index, wd.to, wd.amount === 'max' ? 'max' : BigInt(wd.amount));
          return ctx.reply(`✅ Sent.\nTx: <code>${esc(txid)}</code>\n<a href="${net.explorerTx}${txid}">View on explorer</a>`, HTML);
        } catch (e) {
          return ctx.reply(`❌ Withdrawal failed: ${esc((e as Error).message.slice(0, 300))}`, HTML);
        }
      }
    }
  });

  bot.catch((err) => console.error('[bot]', err.error));
  return bot;
}
