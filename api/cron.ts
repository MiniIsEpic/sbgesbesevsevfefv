import { Api } from 'grammy';
import { botToken } from '../src/config.js';
import { runTracker } from '../src/tracker.js';

/** Hit every 1–5 minutes by Vercel Cron (Pro) or an external scheduler, with "Authorization: Bearer <CRON_SECRET>". */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const result = await runTracker(new Api(botToken()));
  return Response.json(result);
}
