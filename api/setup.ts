import { Api } from 'grammy';
import { botToken } from '../src/config.js';

/** Open once after deploying: https://<your-app>.vercel.app/api/setup?secret=<CRON_SECRET> */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!process.env.CRON_SECRET || url.searchParams.get('secret') !== process.env.CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!process.env.WEBHOOK_SECRET) return new Response('Set WEBHOOK_SECRET first', { status: 500 });

  const api = new Api(botToken());
  const webhook = `https://${url.host}/api/telegram`;
  await api.setWebhook(webhook, {
    secret_token: process.env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await api.setMyCommands([
    { command: 'wallets', description: 'Seeds, accounts and addresses' },
    { command: 'balances', description: 'Live balances' },
    { command: 'check', description: 'Check for new transactions now' },
    { command: 'withdraw', description: 'Withdraw from a whitelisted account' },
    { command: 'autosend', description: 'Auto-forward incoming funds' },
    { command: 'accounts', description: 'List/add accounts of a seed' },
    { command: 'import', description: 'Import a seed phrase' },
    { command: 'threshold', description: 'Set alert threshold (USD)' },
    { command: 'networks', description: 'Supported networks' },
    { command: 'help', description: 'All commands' },
  ]);
  return Response.json({ ok: true, webhook });
}
