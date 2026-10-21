import { InlineKeyboard } from 'grammy';
import { getBalanceSnapshot } from './balances.js';
import { esc, fmtAmount, fmtUsd, short } from './format.js';
import { getAllNetworks } from './networks.js';
import * as store from './store.js';

const PAGE_SIZE = 6;
export const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

const backHome = (kb: InlineKeyboard) => kb.text('🏠 Menu', 'nav:home');

// ---------- home ----------
export async function homeView(uid: number): Promise<View> {
  const wallets = await store.listWallets(uid);
  const settings = await store.getSettings(uid);
  const hasPin = Boolean(settings.pinHash);

  const text = [
    '💼 <b>Wallet Tracker</b>',
    hasPin ? `${wallets.length} seed(s) tracked` : 'Welcome! First, set a PIN.',
    '',
    'Pick an option:',
  ].join('\n');

  const kb = new InlineKeyboard();
  if (!hasPin) {
    kb.text('🔐 Set PIN', 'sec:setpin').row().text('❓ Help', 'nav:help');
    return { text, keyboard: kb };
  }
  kb.text('💰 Wallets & balances', 'nav:wallets:0').row();
  kb.text('➕ Import seed', 'flow:import').text('📤 Withdraw', 'nav:wd').row();
  kb.text('↪️ Auto-send', 'nav:as').text('🔔 Alerts', 'nav:alerts').row();
  kb.text('🛡️ Security', 'nav:sec').text('🌐 Networks', 'nav:net').row();
  kb.text('🔄 Refresh balances', 'nav:wallets:0').text('❓ Help', 'nav:help');
  return { text, keyboard: kb };
}

// ---------- wallets list ----------
export async function walletsView(uid: number, page = 0, force = false): Promise<View> {
  const snap = await getBalanceSnapshot(uid, force);
  const accounts = snap.accounts;
  const pages = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = accounts.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const text = [
    '💰 <b>Wallets</b>',
    `⚙️ ${accounts.length} account(s) · updated ${ago(snap.at)}`,
    '',
    `» <b>${fmtUsd(snap.total)}</b> Total Value`,
  ].join('\n');

  const kb = new InlineKeyboard();
  if (!accounts.length) {
    kb.text('➕ Import your first seed', 'flow:import').row();
  } else {
    for (const a of slice) kb.text(`${a.ref}  »  ${fmtUsd(a.usd)}`, `acct:${a.ref}`).row();
    if (pages > 1) kb.text('‹', `nav:wallets:${p - 1}`).text(`${p + 1}/${pages}`, 'noop').text('›', `nav:wallets:${p + 1}`).row();
  }
  kb.text('🔄 Refresh', `wal:r:${p}`);
  backHome(kb);
  return { text, keyboard: kb };
}

// ---------- account detail ----------
export async function accountView(uid: number, ref: string): Promise<View> {
  const snap = await getBalanceSnapshot(uid);
  const acct = snap.accounts.find((a) => a.ref === ref);
  const [label, idx] = ref.split('.');
  const wallet = await store.getWallet(uid, label);
  const stored = wallet?.accounts.find((a) => a.index === Number(idx));

  if (!acct || !stored || !wallet) {
    return { text: 'That account is no longer available.', keyboard: backHome(new InlineKeyboard()) };
  }

  const lines = [
    `💰 <b>${esc(acct.ref)}</b> — ${fmtUsd(acct.usd)}`,
    '',
    ...(acct.rows.length
      ? acct.rows.map((r) => `${esc(r.name)}: ${fmtAmount(BigInt(r.amount), r.decimals)} ${esc(r.symbol)}${r.usd !== undefined ? ` (${fmtUsd(r.usd)})` : ''}`)
      : ['(no balances)']),
    '',
    `SOL <code>${esc(stored.addresses.sol)}</code>`,
    `EVM <code>${esc(stored.addresses.evm)}</code>`,
    `BTC <code>${esc(stored.addresses.btc)}</code>`,
  ];
  const fwd = Object.entries(stored.forward ?? {});
  if (fwd.length) lines.push('', '<b>Auto-send:</b>', ...fwd.map(([k, r]) => `↪️ ${k} ≥ ${fmtUsd(r.minUsd)} → ${esc(short(r.to))}`));

  const kb = new InlineKeyboard();
  if (wallet.withdraw) kb.text('📤 Withdraw', `wd:a:${acct.ref}`).text('↪️ Auto-send', `as:a:${acct.ref}`).row();
  else kb.text('🔒 Enable withdrawals', `wl:${label}`).row();
  kb.text('🔄 Refresh', `acct:${acct.ref}`).text('‹ Back', 'nav:wallets:0');
  return { text: lines.join('\n'), keyboard: kb };
}

// ---------- pick an account (for withdraw / auto-send) ----------
async function pickAccountView(uid: number, action: 'wd' | 'as'): Promise<View> {
  const wallets = await store.listWallets(uid);
  const usable = wallets.filter((w) => w.withdraw);
  const title = action === 'wd' ? '📤 <b>Withdraw</b>' : '↪️ <b>Auto-send</b>';
  const kb = new InlineKeyboard();

  if (!usable.length) {
    const text = [title, '', 'No accounts are whitelisted yet. Enable withdrawals on a seed first (Security → whitelist).'].join('\n');
    return { text, keyboard: backHome(new InlineKeyboard().text('🛡️ Security', 'nav:sec').row()) };
  }
  for (const w of usable) for (const a of w.accounts) kb.text(store.ref(w.label, a.index), `${action}:a:${store.ref(w.label, a.index)}`).row();
  backHome(kb);
  return { text: [title, '', 'Choose the account to send from:'].join('\n'), keyboard: kb };
}
export const withdrawPickView = (uid: number) => pickAccountView(uid, 'wd');
export const autosendPickView = (uid: number) => pickAccountView(uid, 'as');

// ---------- pick a network ----------
export async function pickNetworkView(uid: number, action: 'wd' | 'as', ref: string): Promise<View> {
  const [label] = ref.split('.');
  const w = await store.getWallet(uid, label);
  if (!w) return { text: 'Account gone.', keyboard: backHome(new InlineKeyboard()) };
  const nets = (await getAllNetworks()).filter((n) => w.networks.includes(n.key));
  const kb = new InlineKeyboard();
  nets.forEach((n, i) => {
    kb.text(n.name, `${action}:n:${ref}:${n.key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  kb.text('‹ Back', action === 'wd' ? 'nav:wd' : 'nav:as');
  const verb = action === 'wd' ? 'withdraw from' : 'auto-send from';
  return { text: `Which network to ${verb} <b>${esc(ref)}</b>?`, keyboard: kb };
}

// ---------- alerts ----------
export async function alertsView(uid: number): Promise<View> {
  const s = await store.getSettings(uid);
  const kb = new InlineKeyboard();
  for (const v of [1, 5, 10, 25, 100]) kb.text(`${s.threshold === v ? '✅ ' : ''}$${v}`, `th:${v}`);
  kb.row().text('✏️ Custom', 'th:custom').row();
  backHome(kb);
  return { text: ['🔔 <b>Alerts</b>', '', `Current global threshold: <b>${fmtUsd(s.threshold)}</b>`, 'Only transactions worth at least this trigger an alert.'].join('\n'), keyboard: kb };
}

// ---------- security ----------
export async function securityView(uid: number): Promise<View> {
  const wallets = await store.listWallets(uid);
  const s = await store.getSettings(uid);
  const kb = new InlineKeyboard();
  kb.text(s.pinHash ? '🔑 Change PIN' : '🔐 Set PIN', s.pinHash ? 'sec:changepin' : 'sec:setpin').row();
  for (const w of wallets) kb.text(`${w.withdraw ? '✅' : '⛔'} ${w.label} withdrawals`, `wl:${w.label}`).row();
  backHome(kb);
  const text = [
    '🛡️ <b>Security</b>',
    '',
    'Tap a seed to allow or block withdrawals and auto-send from it.',
    '✅ = allowed, ⛔ = blocked.',
  ].join('\n');
  return { text, keyboard: kb };
}

// ---------- networks ----------
export async function networksView(uid: number): Promise<View> {
  const wallets = await store.listWallets(uid);
  const nets = await getAllNetworks();
  const kb = new InlineKeyboard();
  for (const w of wallets) kb.text(`${w.label}: ${w.networks.length} network(s)`, `net:w:${w.label}`).row();
  backHome(kb);
  const text = ['🌐 <b>Networks</b>', '', `Supported: ${nets.map((n) => n.key).join(', ')}`, '', 'Tap a seed to turn networks on/off for it.'].join('\n');
  return { text, keyboard: kb };
}

export async function seedNetworksView(uid: number, label: string): Promise<View> {
  const w = await store.getWallet(uid, label);
  if (!w) return { text: 'Seed gone.', keyboard: backHome(new InlineKeyboard()) };
  const nets = await getAllNetworks();
  const kb = new InlineKeyboard();
  nets.forEach((n, i) => {
    const on = w.networks.includes(n.key);
    kb.text(`${on ? '✅' : '⬜'} ${n.key}`, `net:t:${label}:${n.key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('‹ Back', 'nav:net');
  return { text: [`🌐 <b>${esc(label)}</b> networks`, '', 'Tap to toggle. ✅ = tracked.'].join('\n'), keyboard: kb };
}

export const helpView = (): View => ({
  text: [
    '❓ <b>Help</b>',
    '',
    'Everything is reachable from the menu buttons:',
    '• <b>Wallets</b> — balances per account + total',
    '• <b>Import</b> — add a seed phrase',
    '• <b>Withdraw</b> — send funds out (whitelisted seeds)',
    '• <b>Auto-send</b> — forward incoming funds automatically',
    '• <b>Alerts</b> — set the $ threshold for notifications',
    '• <b>Security</b> — PIN and per-seed withdrawal whitelist',
    '• <b>Networks</b> — turn chains on/off per seed',
    '',
    'You can still type commands if you prefer (/wallets, /withdraw …).',
  ].join('\n'),
  keyboard: backHome(new InlineKeyboard()),
});
