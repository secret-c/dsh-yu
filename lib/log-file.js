import fs from 'node:fs';
import path from 'node:path';

/**
 * File logging.
 *
 * The in-memory ring in `log.js` is for the diagnostics page; this sink is for
 * the user's own folder, so `logs/` is a real location rather than a declared
 * one. Writes are buffered and flushed on a short timer (and on shutdown), lines
 * are size-capped, files rotate daily, and old files are pruned.
 */
export function createFileSink({ dir: initialDir, maxBytes = 8 * 1024 * 1024, keepDays = 14, flushMs = 900 } = {}) {
  // `dir` can move with the data root at runtime; the stream is reopened lazily
  // by `open()`, so rebasing only has to drop the current handle.
  let dir = initialDir;
  let stream = null;
  let currentDay = null;
  let buffered = [];
  let timer = null;
  let closed = false;

  const dayKey = () => new Date().toISOString().slice(0, 10);
  const fileFor = (day) => path.join(dir, `yu-${day}.log`);

  const open = () => {
    const day = dayKey();
    if (stream && currentDay === day) return stream;
    try {
      stream?.end();
    } catch {
      /* ignore */
    }
    stream = null;
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(day);
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    stream.on('error', () => {
      stream = null;
    });
    currentDay = day;
    prune(day);
    return stream;
  };

  const prune = (today) => {
    try {
      const cutoff = new Date(`${today}T00:00:00Z`).getTime() - keepDays * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        if (!/^yu-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const day = name.slice(3, 13);
        if (new Date(`${day}T00:00:00Z`).getTime() < cutoff) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
    } catch {
      /* pruning is best effort */
    }
  };

  const flush = () => {
    if (closed || !buffered.length) return;
    const sink = open();
    if (!sink) {
      buffered = [];
      return;
    }
    const text = buffered.join('');
    buffered = [];
    try {
      if ((sink.bytesWritten ?? 0) > maxBytes) sink.end();
      sink.write(text);
    } catch {
      /* a full disk must not take the plugin down */
    }
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    timer.unref?.();
  };

  return {
    write(line) {
      if (closed) return;
      buffered.push(line.endsWith('\n') ? line : `${line}\n`);
      if (buffered.length >= 100) flush();
      else schedule();
    },
    flush,
    close() {
      flush();
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
      stream = null;
    },
    dir: () => dir,
    path: () => (currentDay ? fileFor(currentDay) : null),
    /** Point future writes at a different folder (data-root move). */
    rebase(nextDir) {
      if (!nextDir || nextDir === dir) return { dir };
      flush();
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
      stream = null;
      currentDay = null;
      dir = nextDir;
      return { dir };
    },
  };
}
