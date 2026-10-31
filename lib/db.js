import { DatabaseSync } from 'node:sqlite';

/**
 * Schema history.
 *
 * Each entry is applied in order inside its own transaction and followed by a
 * `meta.schema_version` bump, so an interrupted upgrade lands on the last whole
 * step instead of a half-applied one. Never edit a released step: add the next.
 */
export const SCHEMA_VERSION = 11;

/**
 * The whole Yu schema, version 1. It is applied inside one transaction and
 * guarded by `meta.schema_version`, so a partially applied migration can never
 * be mistaken for a good database.
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  context_id TEXT,
  conversation_mode TEXT NOT NULL DEFAULT 'reuse',
  conversation_id TEXT,
  goal TEXT NOT NULL DEFAULT '',
  input_template TEXT NOT NULL DEFAULT '',
  tool_policy TEXT NOT NULL DEFAULT '{}',
  archive_policy TEXT NOT NULL DEFAULT '{}',
  project_id TEXT,
  max_runtime_ms INTEGER NOT NULL DEFAULT 900000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER,
  last_fired_at INTEGER,
  misfire_policy TEXT NOT NULL DEFAULT 'skip',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS triggers_due ON triggers(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  trigger_id TEXT,
  trigger_reason TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'queued',
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  business_done INTEGER NOT NULL DEFAULT 0,
  archive_done INTEGER NOT NULL DEFAULT 0,
  memory_done INTEGER NOT NULL DEFAULT 0,
  stop_requested_at INTEGER,
  context_snapshot_id TEXT,
  input_text TEXT NOT NULL DEFAULT '',
  output_text TEXT NOT NULL DEFAULT '',
  usage TEXT NOT NULL DEFAULT '{}',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS runs_by_task ON runs(task_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_by_time ON runs(queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_by_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS run_steps_by_run ON run_steps(run_id, at);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS context_versions (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(context_id, version)
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  context_id TEXT,
  context_version INTEGER,
  resolved TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'web',
  channel_id TEXT,
  peer_id TEXT,
  peer_label TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  context_id TEXT,
  session_id TEXT,
  context_snapshot_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  archive_cursor_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS conversations_by_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_by_conv ON messages(conversation_id, at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reading',
  state TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  task_id TEXT,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  from_seq INTEGER NOT NULL DEFAULT 0,
  to_seq INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL,
  path TEXT,
  absorbed_at INTEGER,
  memory_version_id TEXT
);
CREATE INDEX IF NOT EXISTS archives_pending ON archives(absorbed_at);

CREATE TABLE IF NOT EXISTS memory_blocks (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS memory_absorptions (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  archive_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS style_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  content TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS tool_overlays (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  example TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  arguments TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_by_name ON tool_calls(name, at DESC);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disabled',
  last_error TEXT,
  last_event_at INTEGER,
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Inbound dedupe ledger. A redelivered platform event must never produce a
-- second run, and the ledger survives restarts.
CREATE TABLE IF NOT EXISTS channel_events (
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (channel_id, account_id, event_id)
);
CREATE INDEX IF NOT EXISTS channel_events_at ON channel_events(at DESC);

CREATE TABLE IF NOT EXISTS alert_states (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ok',
  since INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_reason TEXT,
  suppressed_until INTEGER,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit(at DESC);

CREATE TABLE IF NOT EXISTS memory_maintenance (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  run_id TEXT,
  version_id TEXT,
  absorbed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
`;

/**
 * Version 2 — the long-term half of memory.
 *
 * `memory_blocks` stays what it always was: the short working set, injected on
 * every turn. These tables add what a block cannot be — atomic, deduplicated,
 * dated statements that accumulate for years, plus the relations and the
 * retrieval ledger that let the console show why Yu remembers something.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fact',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'maintenance',
  source_archive_id TEXT,
  merged_into TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS memories_recent ON memories(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS memories_subject ON memories(subject, last_seen_at DESC);

-- Relations for the graph view. Undirected: a_id < b_id holds by convention.
CREATE TABLE IF NOT EXISTS memory_edges (
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'co-occur',
  weight REAL NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id, kind)
);
CREATE INDEX IF NOT EXISTS memory_edges_a ON memory_edges(a_id);
CREATE INDEX IF NOT EXISTS memory_edges_b ON memory_edges(b_id);

-- Every retrieval that reached a prompt, so "为什么它记得这件事" is answerable.
CREATE TABLE IF NOT EXISTS memory_retrievals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  run_id TEXT,
  memory_ids TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS memory_retrievals_at ON memory_retrievals(at DESC);
`;

/**
 * Version 3 — the text an agent writes about itself.
 *
 * A diary entry, a self-portrait, a glossary: these are not "facts" (one line,
 * deduplicated, retrieved by keyword) and not "blocks" (rewritten wholesale,
 * injected every turn). They are documents — long, hand-edited, opened one at a
 * time. Keeping them in the database rather than as loose Markdown keeps "where
 * Yu's memory lives" a single answer.
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS memory_documents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL DEFAULT '',
  chars INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_documents_by_category ON memory_documents(category, order_index, updated_at DESC);
`;

/**
 * Schema 4: the group message buffer.
 *
 * A group is not a conversation with Yu — it is a room she is standing in. Every
 * message is appended here cheaply, and only when her attention policy says so
 * does she read a window of it. Rows are deleted once memory has absorbed them,
 * so the buffer is a queue with a lifetime, not a transcript archive.
 */
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  text TEXT NOT NULL,
  message_id TEXT,
  at INTEGER NOT NULL,
  answered_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS group_messages_window ON group_messages(channel_id, peer_id, at DESC);
`;

/**
 * Version 5 — the group read cursor.
 *
 * A busy room is a stream, not a fresh conversation every time someone says a
 * word. The cursor records how far into that stream a room has been read, so the
 * next look sends only what arrived since — the earlier lines are already in the
 * session's history. Without it every look re-sent the same thirty messages,
 * which both doubled the token bill and made her answer the same thing twice.
 *
 * `last_look_at` is separate from `last_at` on purpose: it is the attention
 * cooldown (how recently she looked), not how much she has read.
 */
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS group_cursors (
  channel_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  last_at INTEGER NOT NULL DEFAULT 0,
  last_look_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, peer_id)
);
`;

/** Ordered steps; index + 1 is the resulting `meta.schema_version`. */
const SCHEMA_V8 = `CREATE TABLE IF NOT EXISTS memory_sync_consumed (message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, consumed_at INTEGER NOT NULL);`;
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, 'ALTER TABLE tasks ADD COLUMN injection TEXT DEFAULT NULL;', "ALTER TABLE tasks ADD COLUMN execution_target TEXT NOT NULL DEFAULT '{\"mode\":\"yu\"}';", SCHEMA_V8, `ALTER TABLE tasks ADD COLUMN memory_policy TEXT DEFAULT NULL; CREATE TABLE memory_long_consumed(message_id TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL);`, `ALTER TABLE tasks ADD COLUMN delivery_target TEXT NOT NULL DEFAULT '{"mode":"conversation"}'; CREATE TABLE channel_peers(channel_id TEXT NOT NULL,peer_kind TEXT NOT NULL,peer_id TEXT NOT NULL,peer_label TEXT NOT NULL DEFAULT '',last_seen_at INTEGER NOT NULL,PRIMARY KEY(channel_id,peer_kind,peer_id));`, `CREATE TABLE group_glances(binding_id TEXT NOT NULL,channel_id TEXT NOT NULL,peer_id TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,pending TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(binding_id,channel_id,peer_id));`];

export class DbError extends Error {
  constructor(message, code = 'DB_ERROR') {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

/**
 * Opens Yu's SQLite database, applying pending migrations inside a guarded
 * transaction. An unreadable or newer-than-supported database throws instead of
 * being silently mutated, so existing data is never destroyed by a downgrade.
 */
export function openDatabase(dbPath, log) {
  // `raw` is `let`, not `const`: moving the data root swaps the underlying file
  // while every holder of this object keeps working (see `reopen`).
  let raw = null;
  let currentPath = null;
  const stmtCache = new Map();
  const prepare = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const db = {
    get raw() {
      return raw;
    },
    get file() {
      return currentPath;
    },
    get open() {
      return raw !== null;
    },
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      return prepare(sql).run(...params);
    },
    get(sql, ...params) {
      return prepare(sql).get(...params) ?? undefined;
    },
    all(sql, ...params) {
      return prepare(sql).all(...params) ?? [];
    },
    /** IMMEDIATE transaction: one writer at a time, rollback on throw. */
    tx(fn) {
      const nested = raw.isTransaction;
      const savepoint = 'yu_nested_' + Math.random().toString(36).slice(2);
      raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        try {
          raw.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) raw.exec(`RELEASE ${savepoint}`);
        } catch {
          /* the transaction may already be gone */
        }
        throw error;
      }
    },
    getMeta(key, fallback = null) {
      const row = db.get('SELECT value FROM meta WHERE key = ?', key);
      return row ? row.value : fallback;
    },
    setMeta(key, value) {
      db.run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        String(value),
      );
    },
    close() {
      raw?.close();
      raw = null;
    },
    /**
     * Swap the live database to another file without rebuilding the plugin.
     *
     * The new handle is opened and migrated *before* the old one is closed, so a
     * target that fails to migrate leaves the running instance exactly as it was.
     * Callers must stop writers first; Yu asks the scheduler and channels to
     * quiesce before calling this.
     */
    reopen(file) {
      if (currentPath && file === currentPath) return { path: file, schemaVersion: db.schemaVersion, unchanged: true };
      const next = new DatabaseSync(file);
      next.exec('PRAGMA journal_mode = WAL');
      next.exec('PRAGMA synchronous = NORMAL');
      next.exec('PRAGMA foreign_keys = ON');
      next.exec('PRAGMA busy_timeout = 5000');
      const previous = raw;
      raw = next;
      stmtCache.clear();
      try {
        const version = db.migrate();
        currentPath = file;
        try {
          previous?.close();
        } catch {
          /* the old handle may already be gone */
        }
        return { path: file, schemaVersion: version };
      } catch (error) {
        try {
          next.close();
        } catch {
          /* ignore */
        }
        raw = previous;
        stmtCache.clear();
        throw error;
      }
    },
    /** Apply pending schema steps to the current handle. Returns its version. */
    migrate() {
      const hasMeta = Boolean(
        raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get(),
      );
      const stored = hasMeta ? Number(db.getMeta('schema_version', '0')) : 0;
      if (stored > SCHEMA_VERSION) {
        throw new DbError(
          `database schema version ${stored} is newer than this Yu build supports (${SCHEMA_VERSION}); ` +
            'refusing to open it so existing data stays intact',
          'SCHEMA_TOO_NEW',
        );
      }
      for (let step = stored; step < MIGRATIONS.length; step += 1) {
        raw.exec('BEGIN IMMEDIATE');
        try {
          raw.exec(MIGRATIONS[step]);
          db.setMeta('schema_version', String(step + 1));
          raw.exec('COMMIT');
          log?.info(step === 0 ? 'database initialized at schema 1' : `database upgraded to schema ${step + 1}`);
        } catch (error) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw new DbError(`database migration to schema ${step + 1} failed: ${error.message}`, 'SCHEMA_INIT_FAILED');
        }
      }
      db.schemaVersion = MIGRATIONS.length;
      return db.schemaVersion;
    },
    schemaVersion: 0,
  };

  currentPath = dbPath;
  raw = new DatabaseSync(dbPath);
  const pragmas = () => {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
  };
  pragmas();
  try {
    db.migrate();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
