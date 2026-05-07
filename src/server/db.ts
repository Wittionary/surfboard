// SQLite handle, migration runner, and cache helpers per spec §10 and decisions doc.
//
// SQLite stores ONLY metadata about work items: their identity, parent
// pointers, hashes, revision baselines, and sync timestamps. Field content
// (anything inside `spec.fields`) lives only in YAML.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SQLITE_FILE_RELATIVE } from "../shared/constants.ts";
import { migrate } from "./migrations.ts";
import type { CachedWorkItem, SyncStatus, WorkItemType } from "../shared/types.ts";

export type OpenDbOptions = {
  /** Workspace directory; the database file lives at `<workspaceDir>/.surfboard/surfboard.db`. */
  workspaceDir: string;
  /** Override the path entirely; primarily used by tests. Pass `:memory:` for in-memory. */
  path?: string;
};

export type DbHandle = {
  db: Database;
  path: string;
  close: () => void;
};

export function resolveDbPath(workspaceDir: string): string {
  return resolve(join(workspaceDir, SQLITE_FILE_RELATIVE));
}

export function openDb(options: OpenDbOptions): DbHandle {
  const path = options.path ?? resolveDbPath(options.workspaceDir);
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(path);
  migrate(db);
  return {
    db,
    path,
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// work_item_cache helpers
// ---------------------------------------------------------------------------

export type CacheUpsertInput = {
  localId: string;
  adoId?: number;
  workItemType: WorkItemType;
  yamlPath: string;
  yamlDocumentIndex: number;
  parentLocalId?: string;
  parentAdoId?: number;
  localFileHash?: string;
  syncStatus: SyncStatus;
};

type CacheRow = {
  local_id: string;
  ado_id: number | null;
  work_item_type: string;
  yaml_path: string;
  yaml_document_index: number;
  parent_local_id: string | null;
  parent_ado_id: number | null;
  last_known_rev: number | null;
  last_known_field_hash: string | null;
  last_known_relation_hash: string | null;
  last_remote_rev: number | null;
  local_file_hash: string | null;
  sync_status: string;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  remote_changed_at: string | null;
  remote_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function rowToCached(row: CacheRow): CachedWorkItem {
  return {
    localId: row.local_id,
    adoId: row.ado_id ?? undefined,
    workItemType: row.work_item_type as WorkItemType,
    yamlPath: row.yaml_path,
    yamlDocumentIndex: row.yaml_document_index,
    parentLocalId: row.parent_local_id ?? undefined,
    parentAdoId: row.parent_ado_id ?? undefined,
    lastKnownRev: row.last_known_rev ?? undefined,
    lastKnownFieldHash: row.last_known_field_hash ?? undefined,
    lastKnownRelationHash: row.last_known_relation_hash ?? undefined,
    lastRemoteRev: row.last_remote_rev ?? undefined,
    localFileHash: row.local_file_hash ?? undefined,
    syncStatus: row.sync_status as SyncStatus,
    lastPulledAt: row.last_pulled_at ?? undefined,
    lastPushedAt: row.last_pushed_at ?? undefined,
    remoteChangedAt: row.remote_changed_at ?? undefined,
    remoteCheckedAt: row.remote_checked_at ?? undefined,
  };
}

/**
 * Upsert the metadata-only fields of a cache entry. Pulls and pushes have
 * dedicated helpers that update the revision/hash baseline; this helper is for
 * workspace scanning and never touches `last_known_*` columns.
 */
export function upsertWorkItemCache(db: Database, input: CacheUpsertInput): void {
  const now = new Date().toISOString();
  db.run(
    `
    INSERT INTO work_item_cache (
      local_id, ado_id, work_item_type, yaml_path, yaml_document_index,
      parent_local_id, parent_ado_id, local_file_hash, sync_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_id) DO UPDATE SET
      ado_id = excluded.ado_id,
      work_item_type = excluded.work_item_type,
      yaml_path = excluded.yaml_path,
      yaml_document_index = excluded.yaml_document_index,
      parent_local_id = excluded.parent_local_id,
      parent_ado_id = excluded.parent_ado_id,
      local_file_hash = excluded.local_file_hash,
      sync_status = excluded.sync_status,
      updated_at = excluded.updated_at
    `,
    [
      input.localId,
      input.adoId ?? null,
      input.workItemType,
      input.yamlPath,
      input.yamlDocumentIndex,
      input.parentLocalId ?? null,
      input.parentAdoId ?? null,
      input.localFileHash ?? null,
      input.syncStatus,
      now,
      now,
    ],
  );
}

export function getCached(db: Database, localId: string): CachedWorkItem | undefined {
  const row = db
    .query("SELECT * FROM work_item_cache WHERE local_id = ?")
    .get(localId) as CacheRow | null;
  return row ? rowToCached(row) : undefined;
}

export function getAllCached(db: Database): CachedWorkItem[] {
  const rows = db.query("SELECT * FROM work_item_cache ORDER BY local_id").all() as CacheRow[];
  return rows.map(rowToCached);
}

export function getCachedByAdoId(db: Database, adoId: number): CachedWorkItem | undefined {
  const row = db
    .query("SELECT * FROM work_item_cache WHERE ado_id = ?")
    .get(adoId) as CacheRow | null;
  return row ? rowToCached(row) : undefined;
}

export function deleteCacheEntry(db: Database, localId: string): void {
  db.run("DELETE FROM work_item_cache WHERE local_id = ?", [localId]);
}

export function getCachedChildrenByParentLocalId(db: Database, parentLocalId: string): CachedWorkItem[] {
  const rows = db
    .query("SELECT * FROM work_item_cache WHERE parent_local_id = ? ORDER BY local_id")
    .all(parentLocalId) as CacheRow[];
  return rows.map(rowToCached);
}

export function getCachedChildrenByParentAdoId(db: Database, parentAdoId: number): CachedWorkItem[] {
  const rows = db
    .query("SELECT * FROM work_item_cache WHERE parent_ado_id = ? ORDER BY local_id")
    .all(parentAdoId) as CacheRow[];
  return rows.map(rowToCached);
}

/**
 * Updates the accepted baseline (last_known_*) and pull timestamp on a cache
 * row. The row must already exist (call upsertWorkItemCache first). Used by
 * pull when YAML is created or overwritten.
 */
export type BaselineUpdate = {
  localId: string;
  adoId: number;
  rev: number;
  fieldHash: string;
  relationHash: string;
  syncStatus: SyncStatus;
};

export function updateAcceptedBaseline(db: Database, input: BaselineUpdate): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE work_item_cache SET
      ado_id = ?,
      last_known_rev = ?,
      last_known_field_hash = ?,
      last_known_relation_hash = ?,
      last_remote_rev = ?,
      remote_changed_at = NULL,
      remote_checked_at = ?,
      sync_status = ?,
      last_pulled_at = ?,
      updated_at = ?
     WHERE local_id = ?`,
    [
      input.adoId,
      input.rev,
      input.fieldHash,
      input.relationHash,
      input.rev,
      now,
      input.syncStatus,
      now,
      now,
      input.localId,
    ],
  );
}

/**
 * Updates only the remote-observed columns when pull overwrite is declined.
 * Leaves last_known_* untouched per spec §4.2.
 */
export type RemoteObservedUpdate = {
  localId: string;
  remoteRev: number;
  syncStatus: SyncStatus;
};

export function updateRemoteObserved(db: Database, input: RemoteObservedUpdate): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE work_item_cache SET
      last_remote_rev = ?,
      remote_changed_at = ?,
      remote_checked_at = ?,
      sync_status = ?,
      updated_at = ?
     WHERE local_id = ?`,
    [input.remoteRev, now, now, input.syncStatus, now, input.localId],
  );
}
