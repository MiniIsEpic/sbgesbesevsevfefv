function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const botToken = () => required('BOT_TOKEN');

/** 64 hex chars (32 bytes). Combined with your PIN to encrypt seed phrases. */
export const masterKey = () => {
  const k = required('MASTER_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('MASTER_KEY must be 64 hex characters (openssl rand -hex 32)');
  return k;
};

/** Comma-separated Telegram user IDs allowed to use the bot. Everyone else is ignored. */
export const allowedUsers = (): number[] =>
  (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

/** Optional per-transaction cap for withdrawals, in USD. Unset = no cap. */
export const withdrawLimitUsd = (): number | undefined => {
  const v = Number(process.env.WITHDRAW_LIMIT_USD);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

export const DEFAULT_THRESHOLD_USD = Number(process.env.DEFAULT_THRESHOLD_USD ?? 10);

export const redisUrl = () => process.env.UPSTASH_REDIS_REST_URL ?? required('KV_REST_API_URL');
export const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN ?? required('KV_REST_API_TOKEN');
