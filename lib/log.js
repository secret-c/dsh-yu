/**
 * Logging facade. Uses the harness logger when the runtime provides one, falls
 * back to console, keeps a bounded in-memory ring for the diagnostics page, and
 * optionally mirrors every record to the user's own log folder.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /^(token|secret|password|passwd|apiKey|api_key|authToken|auth_token|accessToken|appSecret|app_secret|cookie|code)$/i;

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? (item ? '[redacted]' : item) : scrub(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(ctxLogger, { level = 'info', ringSize = 400, fileSink = null, name = 'yu' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const ring = [];

  const push = (lvl, msg, extra) => {
    const entry = { at: Date.now(), level: lvl, msg: String(msg), extra: extra == null ? null : scrub(extra) };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    try {
      fileSink?.write(`[${new Date(entry.at).toISOString()}] [${lvl.toUpperCase()}] ${entry.msg}${entry.extra == null ? '' : ` ${safeJson(entry.extra)}`}`);
    } catch {
      /* logging must never throw */
    }
  };

  const emit = (lvl, msg, extra) => {
    push(lvl, msg, extra);
    if (LEVELS[lvl] < threshold) return;
    const target = ctxLogger?.[lvl] ?? ctxLogger?.log;
    const text = `[${name}] ${msg}`;
    try {
      if (typeof target === 'function') {
        if (extra == null) target.call(ctxLogger, text);
        else target.call(ctxLogger, `${text} ${safeJson(extra)}`);
        return;
      }
    } catch {
      /* fall through to console */
    }
    const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    if (extra == null) consoleFn(text);
    else consoleFn(text, extra);
  };

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    recent: (limit = 100) => ring.slice(-limit),
    flush: () => fileSink?.flush?.(),
    close: () => fileSink?.close?.(),
    logFile: () => fileSink?.path?.() ?? null,
  };
}

function safeJson(value) {
  try {
    const json = JSON.stringify(value);
    return json && json.length > 600 ? `${json.slice(0, 600)}…` : (json ?? '');
  } catch {
    return String(value);
  }
}
