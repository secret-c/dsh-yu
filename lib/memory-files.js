import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Short-term memory as plain text files.
 *
 * The five blocks used to live only in SQLite, which meant the console was the
 * only way to see or change them: a stale textarea looked like "the default came
 * back", and nothing on disk said what the model was actually being told. Now the
 * text lives in `<dataDir>/memory/short-term/<slug>.md`:
 *
 *   - the file is what a human edits (any editor, any time);
 *   - the file is what the prompt reads — `syncFromFiles` runs before every
 *     compile, so an edit made in vim takes effect on the next run;
 *   - publishing (maintenance, sanitize, restore, manual) writes the files, so
 *     the two never drift in the other direction either.
 *
 * The database keeps what a file cannot: name, category, order, enabled flag, and
 * the version history. The file wins on content conflicts, because that is the
 * copy the user can actually see.
 */

const SIZE_CAP = 200_000;

/**
 * Where the files sit *relative to the configured data root*.
 *
 * Every path the UI and the model see is stated this way first: the root is a
 * setting the user can move (设置 · 数据目录), so an absolute path is a snapshot of
 * one machine's layout while `memory/short-term/recent.md` stays true wherever
 * the root ends up.
 */
export const RELATIVE_DIR = 'memory/short-term';

export function relativeBlockPath(slug) {
  return `${RELATIVE_DIR}/${String(slug).replace(/[^a-z0-9._-]/gi, '_')}.md`;
}

export function memoryDir(paths) {
  return path.join(paths.dataDir, 'memory', 'short-term');
}

export function blockPath(paths, slug) {
  const mapped = paths.memoryFileForSlug?.(slug);
  if(mapped)return path.isAbsolute(mapped)?mapped:path.resolve(paths.dataDir,mapped);
  return path.join(memoryDir(paths), `${String(slug).replace(/[^a-z0-9._-]/gi, '_')}.md`);
}

export function ensureMemoryDir(paths) {
  fs.mkdirSync(memoryDir(paths), { recursive: true });
  return memoryDir(paths);
}

/** `null` means "no file yet", which is different from an empty file. */
export function readBlockFile(paths, slug) {
  try {
    const stat = fs.statSync(blockPath(paths, slug));
    if (stat.size > SIZE_CAP) return fs.readFileSync(blockPath(paths, slug), 'utf8').slice(0, SIZE_CAP);
    return fs.readFileSync(blockPath(paths, slug), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write one block. Atomic on purpose: a half-written memory file is worse than a
 * stale one, and the prompt reads it without any locking.
 */
export function writeBlockFile(paths, block) {
  ensureMemoryDir(paths);
  const target = blockPath(paths, block.slug);
  const body = String(block.content ?? '');
  const current = readBlockFile(paths, block.slug);
  if (current === body) return { path: target, written: false };
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { path: target, written: true };
}

export function deleteBlockFile(paths, slug) {
  try {
    fs.unlinkSync(blockPath(paths, slug));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Write every block the database knows about (after a publish or a restore). */
export function writeAllBlockFiles(repo, paths) {
  ensureMemoryDir(paths);
  let written = 0;
  for (const block of repo.memory.blocks()) {
    if (writeBlockFile(paths, block).written) written += 1;
  }
  return written;
}

/**
 * Bring files and database into agreement.
 *
 * Direction is decided by which copy was touched last, not by an arbitrary rule:
 * a file whose mtime is newer than the row's `updatedAt` was edited by a human and
 * wins; otherwise the database is newer (a publish from the model, a restore) and
 * the file is rewritten. Without that comparison a nightly publish followed by a
 * run would load the stale file back over the fresh memory.
 */
export function syncFromFiles(repo, paths, log = null) {
  if (repo.memory.projectionState?.().pending) {
    const state = repo.memory.repairProjection();
    if (state.pending) throw Object.assign(new Error('memory projection requires repair before import'), { code: 'MEMORY_PROJECTION_PENDING' });
  }
  return repo.memory.deferProjection(() => importFiles(repo, paths, log));
}

function importFiles(repo, paths, log) {
  const dir = ensureMemoryDir(paths);
  const report = { dir, created: 0, loaded: 0, rewritten: 0 };
  for (const block of repo.memory.blocks()) {
    const target = blockPath(paths, block.slug);
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log?.warn?.(`reading memory file ${block.slug}.md failed: ${error.message}`);
        continue;
      }
    }
    if (!stat) {
      if(repo.fileSourceOfTruth)continue;
      writeBlockFile(paths, block);
      report.created += 1;
      continue;
    }
    const text = readBlockFile(paths, block.slug) ?? '';
    if (text !== block.content) {
      try {
        repo.memory.updateBlock(block.slug, { content: text });
        report.loaded += 1;
        log?.info?.(`memory file ${block.slug}.md changed on disk; loaded ${text.length} chars into the database`);
      } catch (error) {
        log?.warn?.(`loading memory file ${block.slug}.md into the database failed: ${error.message}`);
      }
      continue;
    }
  }
  return report;
}

/** A read-only import basis. Callers can send it back to prevent stale import decisions. */
export function previewFileImport(repo, paths) {
  const hash = (text) => text == null ? null : createHash('sha256').update(text).digest('hex');
  return { revision: repo.memory.revision(), files: repo.memory.blocks().map((block) => {
    const content = readBlockFile(paths, block.slug);
    return { slug: block.slug, fileHash: hash(content), databaseHash: hash(block.content), changed: content != null && content !== block.content };
  }), projection: repo.memory.projectionState() };
}

export function validateFileImport(repo, paths, basis = {}) {
  repo.memory.assertRevision(basis.expectedRevision ?? null);
  if (!basis.fileHashes) return;
  const current = previewFileImport(repo, paths);
  for (const file of current.files) {
    if (basis.fileHashes[file.slug] !== file.fileHash) {
      throw Object.assign(new Error('memory file changed after import preview: ' + file.slug), { code: 'MEMORY_FILE_CONFLICT', status: 409 });
    }
  }
}

export function memoryFileHashes(repo, paths, slugs) {
  return Object.fromEntries(slugs.map((slug) => {
    const content = readBlockFile(paths, slug);
    return [slug, content == null ? null : createHash('sha256').update(content).digest('hex')];
  }));
}

export function projectMemoryTargets(repo, paths, targets) {
  // Validate the whole set before changing files: external edits survive retries.
  for (const [slug, target] of Object.entries(targets)) {
    const content = readBlockFile(paths, slug);
    const current = content == null ? null : createHash('sha256').update(content).digest('hex');
    const wanted = target.deleted ? null : repo.memory.blockBySlug(slug)?.content ?? null;
    if (content !== wanted && current !== target.fileHash) throw Object.assign(new Error('file changed since DB commit: ' + slug), { code: 'MEMORY_FILE_CONFLICT' });
  }
  for (const [slug, target] of Object.entries(targets)) {
    if (target.deleted) deleteBlockFile(paths, slug);
    else { const block = repo.memory.blockBySlug(slug); if (block) writeBlockFile(paths, block); }
  }
}
