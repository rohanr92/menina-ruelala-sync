import crypto from 'node:crypto';

function key() {
  const secret = process.env.ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET || 'dev-only-key';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function timingSafeEqual(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Wall-clock parts of `date` in an IANA time zone. */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Next Date (UTC) at which one of the HH:MM `times` occurs in `timeZone`. */
export function nextScheduled(times, timeZone, from = new Date()) {
  if (!times?.length) return null;
  const wanted = new Set(times);
  // Walk forward minute by minute (max 2 days) — cheap and DST-safe.
  const start = new Date(Math.ceil((from.getTime() + 1) / 60000) * 60000);
  for (let i = 0; i < 2 * 24 * 60 + 120; i++) {
    const d = new Date(start.getTime() + i * 60000);
    if (wanted.has(zonedParts(d, timeZone).time)) return d;
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
