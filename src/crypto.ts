import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { masterKey } from './config.js';

// scrypt makes each PIN guess expensive (~100ms, 32MB), so a stolen database is slow to brute-force.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface EncBlob {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

/** Key = scrypt(MASTER_KEY + PIN). Decrypting needs the server secret AND your PIN. */
function deriveKey(pin: string, salt: Buffer): Buffer {
  return scryptSync(`${masterKey()}::${pin}`, salt, 32, SCRYPT);
}

export function encryptSeed(phrase: string, pin: string): EncBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pin, salt), iv);
  const ct = Buffer.concat([cipher.update(phrase, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSeed(enc: EncBlob, pin: string): string {
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(pin, Buffer.from(enc.salt, 'base64')), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Auto-send copy: encrypted with MASTER_KEY only, so the server can sign while you're away.
 * Created only for wallets where you turn auto-send on (with your PIN); deleted when you turn it off.
 */
const AUTO_SECRET = '__auto-send__';
export const encryptAuto = (phrase: string) => encryptSeed(phrase, AUTO_SECRET);
export const decryptAuto = (enc: EncBlob) => decryptSeed(enc, AUTO_SECRET);

export function hashPin(pin: string): { pinSalt: string; pinHash: string } {
  const salt = randomBytes(16);
  return { pinSalt: salt.toString('base64'), pinHash: deriveKey(`verify:${pin}`, salt).toString('base64') };
}

export function verifyPin(pin: string, pinSalt: string, pinHash: string): boolean {
  const got = deriveKey(`verify:${pin}`, Buffer.from(pinSalt, 'base64'));
  const want = Buffer.from(pinHash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}
