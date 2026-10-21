# Telegram Wallet Tracker + Withdraw Bot

Import seed phrases, get an alert for every transaction above a USD threshold (wallet, amount, txid, explorer link), and withdraw from wallets you've whitelisted. Runs on Vercel + Upstash Redis.

**Networks:** Solana, Bitcoin, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, plus any EVM chain you add with `/addnetwork`.

Example alert:

```
🟢 Received
Wallet: main · Solana
+0.0712 SOL ($11.84)

Tx: 4vJ9…kQ2
View on solscan.io
```

## What's tracked

| Chain | How | Alerts include |
|---|---|---|
| Solana | RPC tx history | SOL + USDC/USDT, txid, Solscan link |
| Bitcoin | mempool.space | BTC, txid (incl. unconfirmed), link |
| EVM | Etherscan API v2 (`ETHERSCAN_API_KEY`) | native + USDC/USDT, txid, link |
| EVM, no key | RPC logs + balance polling | USDC/USDT with txid + link; native coin as balance change (no txid) |

Unknown tokens are ignored on purpose so scam airdrops don't spam you. A swap shows as one alert with both legs. The threshold is checked against the biggest leg of each transaction.

## Accounts (multiple wallets per seed)

One seed phrase holds many accounts — the same "Account 1, Account 2…" your wallet app creates. In the bot they're `label.0`, `label.1`, `label.2`, and so on. On import the bot scans and starts tracking every account that already has a balance (always at least `label.0`). Add others yourself with `/addaccount <label> <index>`.

Derivation matches the mainstream apps, so the addresses line up with Phantom, MetaMask, Solflare, Rabby and Trust:

| | Path for account *i* |
|---|---|
| EVM | `m/44'/60'/0'/0/i` |
| Solana | `m/44'/501'/i'/0'` |
| Bitcoin | `m/84'/0'/i'/0/0` |

Tracking, thresholds and networks are set per seed and apply to all its accounts. Withdrawals and auto-send are set per account (`main.1`, `main.2`, …). If you give just `main`, it means `main.0`.

> Etherscan's free tier may not cover every chain. If `/check` shows an Etherscan error for one network, that chain needs a paid plan or a different RPC/indexer.

## Setup

1. **Bot:** message @BotFather → `/newbot` → copy the token. Get your numeric ID from @userinfobot.
2. **Project:** `npm install`, then `npm test` (checks address derivation against known test vectors and encryption round-trip) and `npm run typecheck`.
3. **Vercel:** create a project from this folder. In *Storage* / *Marketplace*, add **Upstash Redis** and connect it (it sets the Redis env vars).
4. **Env vars:** fill in everything from `.env.example` in Vercel → Settings → Environment Variables. Generate secrets with `openssl rand -hex 32` / `-hex 24`. Back up `MASTER_KEY` somewhere offline.
5. **Deploy**, then open once in a browser:
   `https://<your-app>.vercel.app/api/setup?secret=<CRON_SECRET>` → registers the webhook and command menu.
6. **Schedule checks** (how often transactions are picked up):
   - **Vercel Pro:** add to `vercel.json`: `"crons": [{ "path": "/api/cron", "schedule": "*/2 * * * *" }]`. Vercel sends the `CRON_SECRET` automatically.
   - **Vercel Hobby** (cron limited to once a day): use a free external scheduler like cron-job.org → URL `https://<your-app>.vercel.app/api/cron`, every 1–2 min, header `Authorization: Bearer <CRON_SECRET>`.
7. In Telegram: `/setpin` → `/import main` (it finds your active accounts) → `/threshold 10`.

## Commands

| Command | What it does |
|---|---|
| `/setpin`, `/changepin` | PIN that encrypts seeds and signs withdrawals (min 6 chars) |
| `/import <label>` | Add a seed (12/24 words + PIN as last word, one message; deleted immediately). Auto-finds active accounts |
| `/wallets` | Seeds, accounts, addresses, enabled networks, withdraw status |
| `/accounts <label>` | List a seed's accounts and how to add more |
| `/addaccount <label> <index>` | Track another account of a seed (0–19) |
| `/delaccount <label> <index>` | Stop tracking an account |
| `/balances [acct]` | Live native balances in USD |
| `/networks` | Supported network keys |
| `/enable <label> <net,net\|all>` / `/disable …` | Choose networks per seed (all on by default) |
| `/threshold <usd> [label]` | Minimum tx value to alert on, global or per seed |
| `/check` | Run a check now |
| `/whitelist <label> on\|off` | Allow withdrawals + auto-send from that seed (off by default) |
| `/withdraw <acct> <net> <amount\|max> <address>` | Summary → Confirm → PIN → broadcast → txid (e.g. `main.1 sol 0.5 …`) |
| `/autosend <acct> <net> <minUsd> <address>` | Auto-forward incoming tx worth ≥ minUsd to a preset address (confirm + PIN) |
| `/autosend` / `/autosend off <acct> [net]` | List rules / remove them |
| `/addnetwork <key> <chainId> <symbol> <coingeckoId> <rpc> <explorer>` | Add an EVM chain |
| `/delnetwork <key>` | Remove a custom chain |
| `/remove <label>` | Delete a wallet from the bot |

## Auto-send

Set one rule per wallet per network, e.g.:

```
/autosend main sol 10 <your SOL address>
/autosend main.1 eth 25 <your ETH address>
```

Rules are per account, so `main.0` and `main.1` can forward to different addresses. When an incoming transaction on that network is worth at least the minimum, the bot sends **that received amount** to the preset address on the next check, then messages you the txid and explorer link. It works for the native coin and for USDC/USDT (Solana and EVM chains), and for BTC.

- The forwarding wallet needs a little native coin for fees: SOL for Solana token sends (plus ~0.002 SOL the first time a destination receives a given token), ETH/BNB/POL for EVM token sends. If it can't pay, you get an "Auto-send failed" message and the funds stay put.
- Native coins: if paying the fee from what's left isn't possible, it sends everything minus the fee.
- Turning withdrawals off (`/whitelist <label> off`) pauses all auto-send rules on that wallet. `/autosend off <label>` removes them.
- Rules are only created or changed with your PIN; removing them doesn't need it.
- `WITHDRAW_LIMIT_USD` does not apply to auto-sends (the destination is fixed by you), only to `/withdraw`.
- Speed depends on your check interval (1–2 min with an external cron).
- Each transaction is processed once, and a lock stops overlapping checks from double-sending.

## Security — read this

You chose the simplest setup (everything on Vercel, withdrawals to any address). Here's what protects your funds and what doesn't:

**In place**
- The bot ignores everyone except `ALLOWED_USER_IDS`, and only works in private chat. Webhook calls must carry `WEBHOOK_SECRET`.
- Seeds are stored encrypted (AES-256-GCM). The key comes from `MASTER_KEY` **plus your PIN** via scrypt, so a database leak alone, or an env-var leak alone, isn't enough. The PIN is never stored, only a slow hash of it.
- Tracking never decrypts seeds: addresses are derived once at import.
- Withdrawals need the wallet whitelisted, a confirm tap and the PIN. 5 wrong PINs locks withdrawals for an hour. Optional `WITHDRAW_LIMIT_USD` caps each withdrawal.
- Messages containing seeds or PINs are deleted right after the bot reads them.

**Auto-send changes this for the wallets that use it.** To sign while you're away, those wallets get an extra seed copy encrypted with `MASTER_KEY` only. For them, someone with both your Upstash database and your Vercel env vars can decrypt the seed without your PIN. Wallets without auto-send rules don't have that copy, and it is deleted when you remove the last rule.

**Still your risk**
- During a withdrawal the seed exists in memory on Vercel's servers for a moment. Anyone who can change your deployed code (GitHub/Vercel account takeover) could capture the next PIN and seed. Turn on 2FA for Vercel, GitHub, Telegram and Upstash.
- Your seed briefly passes through Telegram's servers when you import it. Telegram bot chats are not end-to-end encrypted.
- With "any address" withdrawals, someone holding your Telegram session **and** your PIN can send funds anywhere. A long PIN and `WITHDRAW_LIMIT_USD` limit the damage.
- **Strong recommendation:** only import hot-wallet seeds holding amounts you could afford to lose. Keep savings on a hardware wallet, never in a bot.

## Notes

- Derivation paths: EVM `m/44'/60'/0'/0/0`, SOL `m/44'/501'/0'/0'` (Phantom/Solflare), BTC `m/84'/0'/0'/0/0` (bc1q…). Always compare `/wallets` with your wallet app — if your app uses another account index or path, the addresses won't match.
- Withdrawals send native coins only (SOL, ETH, BNB, POL, BTC). On Solana, sending to a brand-new address needs at least ~0.00089 SOL (rent minimum).
- Each check looks at up to 25 Solana / 50 BTC / 100 EVM transactions per wallet-network since the last one, which is plenty at 1–2 minute intervals.
