import crypto from 'node:crypto';

/**
 * Password storage and rules. scrypt (built into Node, memory-hard) with a per-password random salt; no extra
 * dependency. Stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later without breaking old hashes.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

const scrypt = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Burn the same time as a real check when the account does not exist, so response time does not reveal who has a login. */
export async function spendCheckTime(password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummy);
}

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 128;

const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd123', 'qwertyuiop', 'qwerty12345', '1234567890', '12345678910', 'iloveyou123', 'welcome123', 'admin12345', 'letmein1234', 'changeme123']);

/** Returns a plain-language problem, or null when the password is acceptable. */
export function passwordProblem(password: string, personal: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A few words in a row works well.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  if (/^(.)\1+$/.test(password)) return 'That password repeats one character. Please choose something less guessable.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is very common. Please choose something less guessable.';
  const local = (personal.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (lower === (personal.email ?? '').toLowerCase() || (local.length >= 5 && lower === local)) return 'The password should not be your email address.';
  if (personal.name && personal.name.length >= 5 && lower === personal.name.toLowerCase()) return 'The password should not be your name.';
  return null;
}

// No 0/O/1/l/I: temporary passwords get read aloud and typed from a message.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A one-time password to hand to a new person; they must change it at first sign-in. About 70 bits. */
export function generatePassword(): string {
  const pick = (): string => ALPHABET[crypto.randomInt(ALPHABET.length)] as string;
  return [4, 4, 4].map((n) => Array.from({ length: n }, pick).join('')).join('-');
}

export const looksLikeEmail = (v: string): boolean => v.length <= 254 && /^[^\s@,;<>()]+@[^\s@,;<>()]+$/.test(v);
