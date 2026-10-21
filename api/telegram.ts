import { webhookCallback } from 'grammy';
import { createBot } from '../src/bot.js';

const bot = createBot();
// grammY's default webhook timeout is 10s. Imports (8 networks), /check, /balances and withdrawals can take longer,
// and on timeout Telegram re-delivers the update, so the same message gets processed twice. Allow up to 50s (Vercel maxDuration is 60).
const handle = webhookCallback(bot, 'std/http', {
  secretToken: process.env.WEBHOOK_SECRET,
  timeoutMilliseconds: 50_000,
});

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
