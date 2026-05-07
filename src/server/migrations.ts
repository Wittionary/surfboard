// SQLite schema migrations per spec §10. Each migration runs once, tracked in
// schema_version. SQLite stores ONLY metadata, never work item content.

import type { Database } from "bun:sqlite";

export type Migration = {
  version: number;
  up: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_item_cache (
        local_id TEXT PRIMARY KEY,
        ado_id INTEGER,
        work_item_type TEXT NOT NULL,
        yaml_path TEXT NOT NULL,
        yaml_document_index INTEGER NOT NULL DEFAULT 0,
        parent_local_id TEXT,
        parent_ado_id INTEGER,
        last_known_rev INTEGER,
        last_known_field_hash TEXT,
        last_known_relation_hash TEXT,
        last_remote_rev INTEGER,
        local_file_hash TEXT,
        sync_status TEXT NOT NULL,
        last_pulled_at TEXT,
        last_pushed_at TEXT,
        remote_changed_at TEXT,
        remote_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_cache_ado_id
        ON work_item_cache(ado_id)
        WHERE ado_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        local_id TEXT,
        ado_id INTEGER,
        work_item_type TEXT,
        yaml_path TEXT,
        before_rev INTEGER,
        after_rev INTEGER,
        before_hash TEXT,
        after_hash TEXT,
        success INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        request_summary TEXT,
        response_summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_local_id
        ON audit_log(local_id);

      CREATE INDEX IF NOT EXISTS idx_audit_log_operation_id
        ON audit_log(operation_id);

      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ado_id INTEGER,
        rev INTEGER,
        raw_payload TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_ado_id
        ON webhook_events(ado_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function getCurrentVersion(db: Database): number {
  const tableExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name?: string } | null;
  if (!tableExists?.name) return 0;
  const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v?: number } | null;
  return row?.v ?? 0;
}

export function migrate(db: Database): { from: number; to: number; applied: number[] } {
  const from = getCurrentVersion(db);
  const applied: number[] = [];

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [
        m.version,
        new Date().toISOString(),
      ]);
    })();
    applied.push(m.version);
  }

  const to = getCurrentVersion(db);
  return { from, to, applied };
}
