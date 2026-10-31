import crypto from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Short, sortable-ish, collision-safe identifier.
 * `task_k3m9x2ab` — readable in URLs and logs, never re-used.
 */
export function id(prefix = 'id') {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += B32[b & 31];
  return `${prefix}_${out}`;
}

export const now = () => Date.now();

/**
 * A URL-safe secret, for hooks that must be unguessable rather than readable.
 *
 * 18 random bytes, base64url: 24 characters, no padding, safe in a path.
 */
export function token(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time string comparison for pairing codes and device tokens. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so the timing does not leak length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 24) {
  return token(bytes);
}

/** Human-friendly one-time pairing code: 4 letters + 4 digits. */
export function randomPairCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const rnd = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 4; i++) out += letters[rnd[i] % letters.length];
  out += '-';
  for (let i = 4; i < 8; i++) out += digits[rnd[i] % digits.length];
  return out;
}

export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

export function pick(source, keys) {
  const out = {};
  for (const k of keys) if (source && source[k] !== undefined) out[k] = source[k];
  return out;
}

export function truncate(text, max = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function asBool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

export function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export const stringifyJson = (value) => JSON.stringify(value ?? null);

export function slugify(text, fallback = 'item') {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** YYYY-MM-DD in the given IANA time zone. */
export function dayKey(ms = Date.now(), timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Wall-clock parts in the given IANA time zone. */
export function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Some ICU builds render midnight as 24.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** Minutes elapsed since local midnight in `timeZone` (0..1439). */
export function minutesOfDay(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** Offset (ms) between the zone's wall clock and UTC at instant `ms`. */
export function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` to an epoch instant.
 * Non-existent local times (DST spring-forward) resolve to the following
 * instant; repeated local times (fall-back) resolve to the earlier one.
 */
export function zonedToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMs(guess, timeZone);
  let instant = guess - offset;
  // Re-derive once across an offset boundary (DST edge).
  const offset2 = zoneOffsetMs(instant, timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    instant = guess - offset;
  }
  return instant;
}

export function startOfDay(dayKeyString, timeZone) {
  const [y, m, d] = String(dayKeyString).split('-').map(Number);
  return zonedToInstant({ year: y, month: m, day: d }, timeZone);
}

export function addDays(dayKeyString, delta) {
  const [y, m, d] = String(dayKeyString).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** ISOBMFF-ish human duration: 1h 04m 09s */
export function humanDuration(ms) {  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Normalized email recipient validation — deliberately strict: one address,
 * no display name, no group syntax.
 */
export function isEmail(value) {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(String(value ?? '').trim());
}

export function maskSecret(value, keep = 4) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= keep * 2) return '•'.repeat(Math.max(4, s.length));
  return `${s.slice(0, keep)}${'•'.repeat(Math.min(16, s.length - keep * 2))}${s.slice(-keep)}`;
}

/** Recursively redact credential-looking keys for logs / API echoes. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|secret|password|passwd|apiKey|api_key|authToken|auth_token|accessToken|appSecret|app_secret|cookie|code)$/i.test(k)) {
        out[k] = v ? maskSecret(v) : v;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human byte size: 512 B / 12.4 KB / 1.9 MB */
export function bytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
}

export function excerpt(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Stable JSON stringify (sorted keys) — used for context hashing. */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Rough token estimate. Documented as an estimate everywhere it surfaces:
 * we cannot observe the provider tokenizer from a plugin.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 3.7);
}
