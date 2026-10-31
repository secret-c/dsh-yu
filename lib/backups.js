import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now } from './util.js';

/**
 * Backup and restore.
 *
 * A backup is a consistent SQLite copy taken after a WAL checkpoint, plus a
 * manifest naming the schema version and digest. Restore never deletes the
 * current database: it is copied aside first, then replaced, and the plugin
 * reports that a restart is required — restoring under a live handle would mean
 * closing and reopening it, which only the data-root move does deliberately.
 */
export function createBackupService({ db, paths, log, version }) {
  let dir = paths.backups;

  const ensureDir = () => fs.mkdirSync(dir, { recursive: true });

  /** Follow a data-root move without a restart. */
  const rebase = (nextPaths) => {
    if (nextPaths?.backups) dir = nextPaths.backups;
    return { dir };
  };

  const sha256File = (file) => {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
  };

  return {
    list() {
      ensureDir();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
      return files
        .map((name) => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          const manifestPath = `${full}.json`;
          let manifest = null;
          try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          } catch {
            manifest = null;
          }
          return {
            name,
            bytes: stat.size,
            createdAt: stat.mtimeMs,
            manifest,
            restorable: true,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async create(label = 'manual', { keep = 7 } = {}) {
      ensureDir();
      // Fold the WAL into the main file so the copy is self-contained.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        log?.warn(`wal checkpoint failed before backup: ${error.message}`);
      }
      const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'manual';
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const name = `yu-${stamp}-${safeLabel}.db`;
      const target = path.join(dir, name);
      fs.copyFileSync(paths.db, target);
      const manifest = {
        name,
        createdAt: now(),
        label: safeLabel,
        version,
        schemaVersion: db.schemaVersion,
        bytes: fs.statSync(target).size,
        sha256: sha256File(target),
        authoritative: true,
        note: '包含 Yu 业务数据；导出用于迁移时应排除凭据（本文件不含 SMTP 密码无法单独剥离，请按文档脱敏）。',
      };
      fs.writeFileSync(`${target}.json`, JSON.stringify(manifest, null, 2), 'utf8');
      log?.info(`backup created: ${name}`);
      // A daily snapshot with no retention grows without bound: 20 MB a day is
      // 7 GB a year, all to protect a database that is smaller than its own
      // backups. Keep a week and drop the rest, newest first.
      try {
        this.prune(keep);
      } catch (error) {
        log?.warn(`pruning old backups failed: ${error.message}`);
      }
      return { ...manifest, path: target };
    },

    /**
     * Keep the newest `keep` snapshots (default 7) and delete older ones with their
     * manifests. A snapshot is only removed after a newer one exists, so there is
     * always at least one backup on disk.
     */
    prune(keep = 7) {
      const manageable = Math.max(2, Math.min(60, Number(keep) || 7));
      const files = this.list();
      const doomed = files.slice(manageable);
      for (const file of doomed) {
        try {
          fs.rmSync(path.join(dir, file.name), { force: true });
          fs.rmSync(path.join(dir, `${file.name}.json`), { force: true });
        } catch (error) {
          log?.warn(`deleting backup ${file.name} failed: ${error.message}`);
        }
      }
      return doomed.length;
    },

    async restore(name) {
      ensureDir();
      if (!/^yu-[0-9A-Za-z._:-]+\.db$/.test(name)) {
        const error = new Error('非法的备份文件名');
        error.status = 400;
        error.code = 'INVALID_BACKUP_NAME';
        throw error;
      }
      const source = path.join(dir, name);
      if (!fs.existsSync(source)) {
        const error = new Error('备份不存在');
        error.status = 404;
        error.code = 'BACKUP_NOT_FOUND';
        throw error;
      }
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(`${source}.json`, 'utf8'));
      } catch {
        manifest = null;
      }
      if (manifest?.schemaVersion && manifest.schemaVersion > db.schemaVersion) {
        const error = new Error(
          `备份的 schema 版本 ${manifest.schemaVersion} 高于当前支持的 ${db.schemaVersion}，已拒绝恢复以保护数据`,
        );
        error.status = 409;
        error.code = 'SCHEMA_TOO_NEW';
        throw error;
      }
      // Safety copy of the live database before it is replaced.
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const safety = path.join(dir, `yu-${stamp}-pre-restore.db`);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort */
      }
      fs.copyFileSync(paths.db, safety);
      // Close first: replacing a file under an open SQLite handle is how a
      // "restore" silently keeps reading the old pages.
      db.close();
      try {
        fs.copyFileSync(source, paths.db);
        for (const suffix of ['-wal', '-shm']) {
          try {
            fs.unlinkSync(`${paths.db}${suffix}`);
          } catch {
            /* absent is fine */
          }
        }
        db.reopen(paths.db);
      } catch (error) {
        // Land on the safety copy rather than on a dead handle.
        try {
          db.reopen(safety);
        } catch (reopenError) {
          log?.error(`restore left the database closed: ${reopenError.message}`);
        }
        throw error;
      }
      log?.warn(`database restored from backup ${name}; live handle swapped`);
      return {
        restored: name,
        safetyCopy: path.basename(safety),
        restartRequired: false,
        note: '已在运行中切换到恢复后的数据库；刷新页面即可看到数据，无需重启插件。',
      };
    },
    rebase,
  };
}
