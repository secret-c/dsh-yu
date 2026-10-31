import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Where Yu keeps its state.
 *
 * One folder holds everything Yu produces: the database, backups, archive
 * Markdown, and a plain-JSONL copy of each of its DSH sessions. The folder is
 * configurable, but the *bootstrap* location must stay fixed, because the
 * database lives inside the configurable root and cannot point at itself:
 *
 *   %LOCALAPPDATA%\Yu\location.json   {"dataDir":"D:\\YuData"}
 *
 * Resolution order: plugin-row `dataDir` (explicit) → pointer file → platform
 * default. A pointer that is unreadable or points at a missing directory falls
 * back to the default with a warning rather than preventing startup.
 */

export function defaultDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Yu');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Yu');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'yu');
}

export const POINTER_FILE = 'location.json';

export function readPointer(bootstrap = defaultDataDir()) {
  const file = path.join(bootstrap, POINTER_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.dataDir === 'string' && parsed.dataDir.trim()) {
      return { dataDir: path.resolve(parsed.dataDir.trim()), file, raw: parsed };
    }
    return { dataDir: null, file, raw: parsed, error: 'pointer has no dataDir' };
  } catch (error) {
    if (error.code === 'ENOENT') return { dataDir: null, file, raw: null };
    return { dataDir: null, file, raw: null, error: error.message };
  }
}

/** Atomically replace the pointer. The directory must already exist. */
export function writePointer(dataDir, bootstrap = defaultDataDir()) {
  const target = path.join(bootstrap, POINTER_FILE);
  fs.mkdirSync(bootstrap, { recursive: true });
  const body = JSON.stringify(
    {
      dataDir: path.resolve(dataDir),
      updatedAt: new Date().toISOString(),
      note: 'Yu 数据根指针。删除本文件即回退到平台默认目录。',
    },
    null,
    2,
  );
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

export function clearPointer(bootstrap = defaultDataDir()) {
  const target = path.join(bootstrap, POINTER_FILE);
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function resolvePaths(config = {}, log = null) {
  const bootstrap = defaultDataDir();
  const configured = String(config.dataDir ?? '').trim();
  const pointer = configured ? { dataDir: null, file: path.join(bootstrap, POINTER_FILE) } : readPointer(bootstrap);

  let dataDir;
  let source;
  if (configured) {
    dataDir = path.resolve(configured);
    source = 'config';
  } else if (pointer.dataDir) {
    dataDir = pointer.dataDir;
    source = 'pointer';
  } else {
    dataDir = bootstrap;
    source = 'default';
  }

  if (source !== 'default' && !usable(dataDir)) {
    log?.warn(`data root ${dataDir} (from ${source}) is not writable; falling back to ${bootstrap}`);
    dataDir = bootstrap;
    source = 'fallback';
  }

  const files = path.join(dataDir, 'files');
  return {
    dataDir,
    source,
    bootstrap,
    pointerFile: path.join(bootstrap, POINTER_FILE),
    files,
    db: path.join(dataDir, 'yu.db'),
    pairingCode: path.join(dataDir, 'pairing-code.txt'),
    backups: path.join(dataDir, 'backups'),
    logs: path.join(dataDir, 'logs'),
    sessions: path.join(dataDir, 'sessions'),
    exports: path.join(dataDir, 'exports'),
    // Archives stay under `files/` so an existing install keeps writing to the
    // same place: moving them would split one logical store across two roots.
    archivesDir: path.join(files, 'archives'),
    uploads: path.join(dataDir, 'uploads'),
    knowledgeDir: path.join(files, 'knowledge'),
  };
}

export function ensureDirs(paths) {
  for (const dir of [
    paths.dataDir,
    paths.files,
    paths.backups,
    paths.logs,
    paths.sessions,
    paths.exports,
    paths.archivesDir,
    paths.uploads,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function writePrivateFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

/** Human label + purpose for every path Yu owns, used by the settings page. */
export function describePaths(paths) {
  return [
    { key: 'data', label: '数据根', path: paths.dataDir, purpose: '所有 Yu 数据的根目录', kind: 'dir' },
    { key: 'db', label: '数据库', path: paths.dataDir, purpose: '权威数据库 yu.db（含 -wal / -shm）', kind: 'dir', file: paths.db },
    { key: 'backups', label: '备份', path: paths.backups, purpose: '手动与迁移前的整库备份 + 清单', kind: 'dir' },
    { key: 'archives', label: '归档 Markdown', path: paths.archivesDir, purpose: '已完成运行的归档投影（派生，权威在库内）', kind: 'dir' },
    { key: 'sessions', label: '会话原文副本', path: paths.sessions, purpose: 'Yu 会话的明文 JSONL 副本（DSH 原日志仍是运行中的权威）', kind: 'dir' },
    { key: 'exports', label: '导出', path: paths.exports, purpose: '记忆 / style 的 Markdown 导出', kind: 'dir' },
    { key: 'logs', label: '日志', path: paths.logs, purpose: '按天切分的宿主日志，已脱敏', kind: 'dir' },
    { key: 'uploads', label: '上传', path: paths.uploads, purpose: '预留给渠道附件', kind: 'dir' },
    { key: 'knowledge', label: '知识库', path: paths.knowledgeDir, purpose: '可选的 knowledge.sqlite3 副本', kind: 'dir' },
  ];
}
