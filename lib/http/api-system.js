import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError } from '../http/router.js';
import { now, bytes as fmtBytes } from '../util.js';

/**
 * Filesystem-facing operations for the console: browsing for a target folder,
 * revealing a known folder in the OS file manager, and exporting memory.
 *
 * Two hard rules:
 *  - `reveal` accepts only a **key** from a fixed whitelist; it never receives a
 *    path from the client, so it cannot be turned into "open anything".
 *  - `dirs` lists directories only and never returns file contents.
 */
export function registerSystemApi(router, app) {
  const { paths, repo, log } = app;

  const REVEALABLE = {
    data: () => paths.dataDir,
    db: () => paths.dataDir,
    backups: () => paths.backups,
    archives: () => paths.archivesDir,
    sessions: () => paths.sessions,
    exports: () => paths.exports,
    logs: () => paths.logs,
    uploads: () => paths.uploads,
    knowledge: () => paths.knowledgeDir,
  };

  // ------------------------------------------------------------ data root
  router.get('/api/data-root', async () => app.dataRoot.status());

  router.post('/api/data-root/precheck', async ({ body }) => app.dataRoot.precheck(body?.target));

  router.post('/api/data-root/apply', async ({ body }) => {
    const result = await app.dataRoot.apply(body?.target, { confirm: body?.confirm === true });
    app.repo.audit.log('dataRoot.switch', result.target, { previous: result.previous, mode: result.mode }, 'user');
    return result;
  });

  router.post('/api/data-root/reset-pointer', async () => {
    const result = app.dataRoot.resetPointer();
    if (result.ok) app.repo.audit.log('dataRoot.reset', result.removed ?? '', {}, 'user');
    return result;
  });

  router.get('/api/data-root/inventory', async () => app.dataRoot.inventory());

  // ------------------------------------------------------- directory picker
  router.get('/api/system/dirs', async ({ query }) => {
    const requested = String(query.path ?? '').trim();
    const roots = [];
    if (process.platform === 'win32') {
      for (let code = 65; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:\\`;
        if (fs.existsSync(drive)) roots.push(drive);
      }
    } else {
      roots.push('/');
      try {
        for (const name of fs.readdirSync('/mnt')) roots.push(`/mnt/${name}`);
      } catch {
        /* no /mnt */
      }
    }
    const current = requested ? path.resolve(requested) : roots[0] ?? '/';
    let entries = [];
    let error = null;
    try {
      entries = fs
        .readdirSync(current, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    } catch (failure) {
      error = failure.message;
    }
    const parent = path.dirname(current);
    return {
      path: current,
      parent: parent === current ? null : parent,
      roots,
      entries,
      error,
      writable: (() => {
        try {
          fs.accessSync(current, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })(),
    };
  });

  // --------------------------------------------------------------- reveal
  router.post('/api/system/reveal', async ({ body }) => {
    const key = String(body?.key ?? '');
    const resolvePath = REVEALABLE[key];
    if (!resolvePath) {
      throw new HttpError(400, 'INVALID_REVEAL_KEY', `不允许打开的位置：${key || '（空）'}`);
    }
    const target = resolvePath();
    if (!fs.existsSync(target)) {
      throw new HttpError(404, 'PATH_MISSING', `位置不存在：${target}`);
    }
    const command =
      process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      throw new HttpError(500, 'REVEAL_FAILED', `无法启动文件管理器：${error.message}`);
    }
    repo.audit.log('system.reveal', key, { target }, 'user');
    return { ok: true, key, target, note: '已在系统文件管理器中打开；若没反应，请复制路径手动打开。' };
  });

  // --------------------------------------------------------------- export
  router.post('/api/memory/export', async () => {
    const markdown = app.memoryService.exportMarkdown();
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(paths.exports, `memory-${stamp}.md`);
    try {
      fs.mkdirSync(paths.exports, { recursive: true });
      fs.writeFileSync(file, markdown, { mode: 0o600 });
    } catch (error) {
      throw new HttpError(500, 'EXPORT_FAILED', `写入导出文件失败：${error.message}`);
    }
    repo.audit.log('memory.export', file, { bytes: Buffer.byteLength(markdown) }, 'user');
    return { ok: true, path: file, bytes: Buffer.byteLength(markdown), preview: markdown.slice(0, 400) };
  });

  // ------------------------------------------------------------ diagnostics
  router.get('/api/system/sessions', async () => ({
    mirror: app.sessionMirror.summary(),
    note: 'DSH 的原日志位于 ~/.dsh/sessions/...，仍是运行中的权威；这里是 Yu 自己持有的明文副本。',
  }));

  /**
   * Public, read-only entry summary.
   *
   * The DSH settings page runs on the harness origin and needs to show "where do
   * I open Yu / where does it keep files" without a device session. This endpoint
   * therefore carries facts only — no task text, no memory, no credentials, no
   * pairing code — and enumerating it can never change state.
   */
  router.get(
    '/api/entry',
    async () => {
      const status = app.dataRoot.status();
      const inventory = app.dataRoot.inventory();
      const runner = app.runner.stats();
      return {
        service: 'yu',
        version: app.version,
        startedAt: app.startedAt,
        uptimeMs: now() - app.startedAt,
        harness: { version: app.harness.version, supported: app.compat.supported, reason: app.compat.reason },
        // The harness mount is the address a browser on this machine can actually
        // reach: the plugin's own listener can collide with another install's port
        // (WSL keeps 58800 inside the VM, Windows uses it on the host).
        adminUrl: app.harnessUrl ?? app.httpService.url(),
        localUrl: app.httpService.url(),
        harnessUrl: app.harnessUrl,
        dataRoot: { path: status.dataDir, source: status.source, bytes: status.totalBytes, freeBytes: status.freeBytes },
        pairing: { devices: app.auth.activeDevices(), pendingCode: app.auth.hasPendingCode() },
        runtime: { active: runner.active, queued: runner.queued, maxParallel: runner.maxParallel },
        paths: inventory.rows.map((row) => ({
          key: row.key,
          label: row.label,
          path: row.path,
          purpose: row.purpose,
          type: row.kind,
          bytes: row.bytes,
          files: row.files,
          exists: row.exists,
          human: fmtBytes(row.bytes),
        })),
        note: '只读摘要：不含任务内容、记忆正文与任何凭据。',
      };
    },
    { public: true },
  );
}
