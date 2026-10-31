import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { POINTER_FILE, defaultDataDir, describePaths, writePointer, readPointer, resolvePaths, ensureDirs, clearPointer } from './paths.js';

/**
 * Moving the data root.
 *
 * The root holds the database, so it cannot point at itself: the choice is
 * recorded in a bootstrap pointer (`%LOCALAPPDATA%\Yu\location.json`).
 *
 * Moving it used to take effect only after reinstalling the plugin, which in
 * practice meant "the folder never moves". It is now a **live switch**:
 *
 *   1. quiesce the writers (scheduler, channels, alert monitor);
 *   2. `VACUUM INTO` a consistent snapshot of the live database;
 *   3. verify the snapshot opens and passes `integrity_check`;
 *   4. copy the side folders;
 *   5. write the pointer;
 *   6. reopen the live database handle on the new file (`db.reopen`);
 *   7. rebase `paths` in place and let each service follow it.
 *
 * Steps 6–7 happen after the snapshot is verified, and a failure at any point
 * puts the old handle and the old paths back. The old folder is never deleted,
 * so a botched move is a copy, not a loss.
 */

const COPY_DIRS = ['backups', 'files', 'sessions', 'logs', 'exports', 'uploads'];

function walkSize(dir, { maxFiles = 50_000 } = {}) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxFiles) return { bytes, files, truncated: true };
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return { bytes, files, truncated: false };
}

function freeBytesFor(target) {
  let probe = path.resolve(target);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const stats = fs.statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function isNested(a, b) {
  const rel = path.relative(a, b);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function copyTree(src, dst, { skipSame = true } = {}) {
  let copied = 0;
  let bytes = 0;
  let skipped = 0;
  const stack = [[src, dst]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      continue;
    }
    fs.mkdirSync(to, { recursive: true });
    for (const entry of entries) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) {
        stack.push([source, target]);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (skipSame && fs.existsSync(target)) {
          const a = fs.statSync(source);
          const b = fs.statSync(target);
          if (a.size === b.size) {
            skipped += 1;
            continue;
          }
        }
        fs.copyFileSync(source, target);
        copied += 1;
        bytes += fs.statSync(target).size;
      } catch {
        /* one unreadable file must not abort the migration */
      }
    }
  }
  return { copied, skipped, bytes };
}

export function createDataRootService({ db, paths, log }) {
  // Filled by `attach` once the services that hold paths exist. Until then the
  // service still answers status/precheck, just cannot perform a live switch.
  let hooks = { quiesce: null, resume: null, rebase: null, activeRuns: null };
  let switching = false;

  const attach = (next = {}) => {
    hooks = { ...hooks, ...next };
    return { attached: Object.entries(hooks).filter(([, value]) => typeof value === 'function').map(([key]) => key) };
  };
  const isSwitching = () => switching;

  const known = () =>
    [
      ['backups', paths.backups],
      ['files', paths.files],
      ['archives', paths.archivesDir],
      ['sessions', paths.sessions],
      ['exports', paths.exports],
      ['logs', paths.logs],
      ['uploads', paths.uploads],
      ['knowledge', paths.knowledgeDir],
    ].filter(([, dir]) => dir);

  const status = () => {
    const children = [];
    for (const [key, dir] of known()) {
      const exists = fs.existsSync(dir);
      const size = exists ? walkSize(dir) : { bytes: 0, files: 0 };
      children.push({ key, path: dir, exists, bytes: size.bytes, files: size.files, truncated: Boolean(size.truncated) });
    }
    let dbBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        dbBytes += fs.statSync(`${paths.db}${suffix}`).size;
      } catch {
        /* absent */
      }
    }
    const total = dbBytes + children.reduce((sum, child) => sum + child.bytes, 0);
    const pointer = readPointer(defaultDataDir());
    return {
      dataDir: paths.dataDir,
      source: paths.source,
      bootstrap: paths.bootstrap,
      pointerFile: paths.pointerFile,
      pointerTarget: pointer.dataDir,
      pointerError: pointer.error ?? null,
      switching,
      live: true,
      db: { path: paths.db, bytes: dbBytes, exists: fs.existsSync(paths.db), schemaVersion: db.schemaVersion },
      totalBytes: total,
      freeBytes: freeBytesFor(paths.dataDir),
      children,
      note:
        paths.source === 'config'
          ? '插件行 config 显式指定了 dataDir，页面上的更改不会生效；请先清空该配置项。'
          : '数据根由 location.json 指针决定；更改会立即生效（运行中切换数据库句柄），无需重启。',
    };
  };

  const precheck = (target) => {
    const problems = [];
    const warnings = [];
    const raw = String(target ?? '').trim();
    if (!raw) {
      return { ok: false, problems: ['请填写目标目录'], warnings, target: null };
    }
    const resolved = path.resolve(raw);
    const absolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
    if (!absolute) problems.push('必须是绝对路径');
    if (paths.source === 'config') {
      problems.push('插件行 config 已显式设置 dataDir，请先把它清空再使用页面迁移');
    }
    if (resolved === path.resolve(paths.dataDir)) problems.push('目标与当前数据根相同');
    if (isNested(path.resolve(paths.dataDir), resolved)) problems.push('目标不能位于当前数据根内部');
    if (isNested(resolved, path.resolve(paths.dataDir))) problems.push('当前数据根不能位于目标内部');
    if (resolved === defaultDataDir()) warnings.push('目标是平台默认位置');
    if (fs.existsSync(path.join(resolved, 'yu.db'))) {
      problems.push('目标目录里已经有 yu.db，迁移会覆盖它；请换一个空目录');
    }

    const currentBytes = status().totalBytes;
    const requiredBytes = Math.ceil(currentBytes * 1.5);
    const free = freeBytesFor(resolved);

    // Structural refusals must not touch the filesystem: a rejected precheck
    // must never leave an empty directory behind.
    if (problems.length) {
      return { ok: false, problems, warnings, target: resolved, writable: false, currentBytes, freeBytes: free, requiredBytes };
    }

    let writable = false;
    try {
      fs.mkdirSync(resolved, { recursive: true });
      const probe = path.join(resolved, `.yu-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      writable = true;
    } catch (error) {
      problems.push(`目标不可写：${error.message}`);
    }

    if (free !== null && free < requiredBytes) {
      problems.push(
        `可用空间不足：需要约 ${Math.ceil(requiredBytes / 1024 / 1024)} MB，当前 ${Math.floor(free / 1024 / 1024)} MB`,
      );
    }
    return {
      ok: problems.length === 0,
      problems,
      warnings,
      target: resolved,
      writable,
      currentBytes,
      freeBytes: free,
      requiredBytes,
    };
  };

  const verifyDb = (file) => {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get();
      const version = copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      const tasks = copy.prepare('SELECT COUNT(*) AS n FROM tasks').get();
      return {
        integrity: integrity?.integrity_check ?? 'unknown',
        schemaVersion: version ? Number(version.value) : null,
        tasks: Number(tasks?.n ?? 0),
      };
    } finally {
      copy.close();
    }
  };

  /**
   * Move the data root and switch to it without restarting the plugin.
   *
   * Synchronous from the snapshot to the reopen: Node runs one callback at a
   * time, so nothing can write to the database between "verified copy" and "new
   * handle is live". The copy of side folders is the only slow part and it
   * happens while writers are still quiesced.
   */
  const apply = async (target, { confirm = false } = {}) => {
    if (!confirm) {
      const error = new Error('迁移需要显式确认（confirm: true）');
      error.status = 400;
      error.code = 'CONFIRM_REQUIRED';
      throw error;
    }
    if (switching) {
      const error = new Error('已有一次数据根切换正在进行');
      error.status = 409;
      error.code = 'SWITCH_IN_PROGRESS';
      throw error;
    }
    if (typeof hooks.quiesce !== 'function' || typeof hooks.rebase !== 'function') {
      const error = new Error('运行中切换尚未就绪（服务未挂接），请重启插件后再试');
      error.status = 503;
      error.code = 'SWITCH_NOT_READY';
      throw error;
    }
    const active = Number(hooks.activeRuns?.() ?? 0);
    if (active > 0) {
      const error = new Error(`有 ${active} 个任务正在运行；等它们结束再迁移，避免半途换库`);
      error.status = 409;
      error.code = 'BUSY';
      throw error;
    }

    const check = precheck(target);
    if (!check.ok) {
      const error = new Error(check.problems.join('；'));
      error.status = 409;
      error.code = 'DATA_ROOT_REJECTED';
      error.detail = check;
      throw error;
    }

    const resolved = check.target;
    const previousRoot = paths.dataDir;
    const previousPaths = { ...paths };
    const startedAt = Date.now();
    switching = true;
    let quiesced = false;
    let pointerWritten = false;
    let swapped = false;
    log?.info(`data root switch started: ${previousRoot} -> ${resolved}`);

    try {
      if (hooks.quiesce) {
        await hooks.quiesce();
        quiesced = true;
      }

      // 1. Consistent snapshot of the live database.
      const targetDb = path.join(resolved, 'yu.db');
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort: VACUUM INTO is consistent regardless */
      }
      try {
        if (fs.existsSync(targetDb)) fs.unlinkSync(targetDb);
        const escaped = targetDb.replace(/'/g, "''");
        db.raw.exec(`VACUUM INTO '${escaped}'`);
      } catch (error) {
        const failure = new Error(`数据库快照失败：${error.message}`);
        failure.status = 500;
        failure.code = 'VACUUM_FAILED';
        throw failure;
      }

      // 2. Verify before anything is switched.
      let verification;
      try {
        verification = verifyDb(targetDb);
      } catch (error) {
        const failure = new Error(`新目录里的数据库无法打开：${error.message}`);
        failure.status = 500;
        failure.code = 'VERIFY_FAILED';
        throw failure;
      }
      if (verification.integrity !== 'ok') {
        const failure = new Error(`新目录里的数据库完整性检查失败：${verification.integrity}`);
        failure.status = 500;
        failure.code = 'VERIFY_FAILED';
        throw failure;
      }

      // 3. Copy the side data. `logs` is copied last because the quiesce step
      //    does not stop the logger from flushing a buffered line.
      const copied = {};
      for (const key of COPY_DIRS) {
        const source = paths[key] ?? (key === 'files' ? paths.files : null);
        if (!source || !fs.existsSync(source)) continue;
        const dest = path.join(resolved, key === 'files' ? 'files' : key);
        copied[key] = copyTree(source, dest);
      }

      // 4. Pointer next: from here on a crash boots into the new root.
      writePointer(resolved);
      pointerWritten = true;

      // 5. Swap the live handle and rebase every holder of `paths`.
      const reopened = db.reopen(targetDb);
      swapped = true;
      Object.assign(paths, resolvePaths({}));
      ensureDirs(paths);
      hooks.rebase(paths, previousPaths);

      const result = {
        ok: true,
        mode: 'live',
        target: resolved,
        previous: previousRoot,
        verification,
        reopened,
        copied,
        restartRequired: false,
        durationMs: Date.now() - startedAt,
        pointerFile: paths.pointerFile,
        note:
          '已切到新目录并立即生效：数据库句柄已重新打开，任务、渠道与日志已重新挂到新路径。' +
          '旧目录保持原样未删除，确认无误后可以自行删除。',
      };
      log?.info(`data root switch finished in ${result.durationMs}ms; pointer -> ${resolved}`);
      return result;
    } catch (error) {
      // Put the world back if the switch got half way.
      if (swapped) {
        try {
          db.reopen(path.join(previousRoot, 'yu.db'));
        } catch (reopenError) {
          log?.error(`rolling the database handle back to ${previousRoot} failed: ${reopenError.message}`);
        }
        Object.assign(paths, previousPaths);
      }
      if (pointerWritten) {
        try {
          clearPointer();
        } catch {
          /* ignore */
        }
      }
      log?.error(`data root switch failed: ${error.message}`);
      throw error;
    } finally {
      switching = false;
      if (quiesced && hooks.resume) {
        try {
          await hooks.resume();
        } catch (error) {
          log?.warn(`resuming after a data-root switch failed: ${error.message}`);
        }
      }
    }
  };

  const resetPointer = () => {
    const file = path.join(defaultDataDir(), POINTER_FILE);
    try {
      fs.unlinkSync(file);
      return { ok: true, removed: file, restartRequired: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  /** One row per location Yu writes to: what it is, where, how big, how many. */
  const inventory = () => {
    const st = status();
    const byKey = new Map(st.children.map((child) => [child.key, child]));
    const rows = [
      {
        key: 'db',
        label: '数据库',
        path: paths.db,
        purpose: '权威数据库，含 -wal / -shm 两个伴随文件',
        kind: 'file',
        bytes: st.db.bytes,
        files: st.db.exists ? 1 : 0,
        exists: st.db.exists,
      },
    ];
    for (const entry of describePaths(paths)) {
      if (entry.key === 'data' || entry.key === 'db') continue;
      const size = byKey.get(entry.key);
      rows.push({
        key: entry.key,
        label: entry.label,
        path: entry.path,
        purpose: entry.purpose,
        kind: entry.kind,
        bytes: size?.bytes ?? 0,
        files: size?.files ?? 0,
        exists: size?.exists ?? fs.existsSync(entry.path),
      });
    }
    rows.push({
      key: 'pairing',
      label: '配对码',
      path: paths.pairingCode,
      purpose: '仅在没有任何已配对设备时存在，配对成功后删除',
      kind: 'file',
      bytes: fs.existsSync(paths.pairingCode) ? fs.statSync(paths.pairingCode).size : 0,
      files: fs.existsSync(paths.pairingCode) ? 1 : 0,
      exists: fs.existsSync(paths.pairingCode),
    });
    rows.push({
      key: 'pointer',
      label: '数据根指针',
      path: paths.pointerFile,
      purpose: '记录数据根位置；删除它即回退到平台默认目录（需重启）',
      kind: 'file',
      bytes: fs.existsSync(paths.pointerFile) ? fs.statSync(paths.pointerFile).size : 0,
      files: fs.existsSync(paths.pointerFile) ? 1 : 0,
      exists: fs.existsSync(paths.pointerFile),
    });
    return { rows, totalBytes: st.totalBytes, dataDir: st.dataDir, source: st.source };
  };

  return {
    status,
    precheck,
    apply,
    attach,
    isSwitching,
    resetPointer,
    inventory,
    pointerFile: () => path.join(defaultDataDir(), POINTER_FILE),
  };
}
