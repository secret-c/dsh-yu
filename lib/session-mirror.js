import fs from 'node:fs';
import path from 'node:path';

/**
 * Plain-JSONL copies of Yu's own DSH sessions.
 *
 * DSH owns the live session log (`~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd`)
 * and remains authoritative while a session runs. This mirror exists so that one
 * folder — Yu's data root — contains everything Yu produced, in a form you can
 * grep, back up, and hand to another tool without a zstd decoder.
 *
 * It is deliberately append-only and incremental: the highest `seq` already on
 * disk is the resume point, so re-running the mirror after every run never
 * duplicates a line, and a crash mid-write can only truncate the trailing line.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const safeName = (sessionId) => String(sessionId ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'session';

function lastSeqOnDisk(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { seq: -1, size: 0 };
  }
  if (!stat.size) return { seq: -1, size: 0 };
  const window = Math.min(stat.size, 64 * 1024);
  const buffer = Buffer.alloc(window);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, buffer, 0, window, stat.size - window);
  } finally {
    fs.closeSync(handle);
  }
  const lines = buffer.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (Number.isFinite(parsed?.seq)) return { seq: parsed.seq, size: stat.size };
    } catch {
      // A torn trailing line: keep looking backwards for the last good one.
      continue;
    }
  }
  return { seq: -1, size: stat.size };
}

export function createSessionMirror({ paths, log, agentHost }) {
  let dir = paths.sessions;

  const ensure = () => fs.mkdirSync(dir, { recursive: true });

  const rotate = (file) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = file.replace(/\.jsonl$/, `.${stamp}.jsonl`);
    fs.renameSync(file, target);
    return target;
  };

  return {
    dir,

    /** Follow a data-root move without a restart. */
    rebase(nextPaths) {
      if (nextPaths?.sessions) dir = nextPaths.sessions;
      return { dir };
    },

    /**
     * Append every session event not yet mirrored.
     * @returns {{path: string|null, appended: number, lastSeq: number, reason?: string}}
     */
    mirror(sessionId, { maxBytes = MAX_FILE_BYTES } = {}) {
      if (!sessionId) return { path: null, appended: 0, lastSeq: -1, reason: 'no session id' };
      let events = [];
      try {
        events = agentHost.readEvents(sessionId, 0);
      } catch (error) {
        log?.debug(`session mirror: cannot read ${sessionId}: ${error.message}`);
      }
      if (!Array.isArray(events) || !events.length) {
        return { path: null, appended: 0, lastSeq: -1, reason: 'session is not live' };
      }
      try {
        ensure();
        const file = path.join(dir, `${safeName(sessionId)}.jsonl`);
        let { seq: lastSeq, size } = lastSeqOnDisk(file);
        if (size > maxBytes) {
          const archived = rotate(file);
          log?.info(`session mirror rotated ${path.basename(file)} -> ${path.basename(archived)}`);
          lastSeq = -1;
        }
        const fresh = events.filter((event) => Number(event.seq) > lastSeq);
        if (!fresh.length) {
          return { path: file, appended: 0, lastSeq };
        }
        const lines = fresh
          .map((event) =>
            JSON.stringify({
              seq: event.seq,
              time: event.time,
              type: event.type,
              data: event.data,
            }),
          )
          .join('\n');
        fs.appendFileSync(file, `${lines}\n`, { mode: 0o600 });
        const newLast = Number(fresh[fresh.length - 1].seq);
        return { path: file, appended: fresh.length, lastSeq: newLast };
      } catch (error) {
        log?.warn(`session mirror failed for ${sessionId}: ${error.message}`);
        return { path: null, appended: 0, lastSeq: -1, reason: error.message };
      }
    },

    /** Counts and sizes for the settings page. */
    summary() {
      const empty = { dir, files: 0, bytes: 0, newest: null, newestAt: null };
      try {
        const names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
        let bytes = 0;
        let newestAt = 0;
        let newest = null;
        for (const name of names) {
          const stat = fs.statSync(path.join(dir, name));
          bytes += stat.size;
          if (stat.mtimeMs > newestAt) {
            newestAt = stat.mtimeMs;
            newest = name;
          }
        }
        return { dir, files: names.length, bytes, newest, newestAt: newestAt || null };
      } catch {
        return empty;
      }
    },

    /** The mirrored copy of one session, as parsed events (for diagnostics). */
    read(sessionId, { limit = 200 } = {}) {
      const file = path.join(dir, `${safeName(sessionId)}.jsonl`);
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        return lines
          .slice(-limit)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
