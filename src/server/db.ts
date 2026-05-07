// SQLite handle and migration runner per spec §10 and decisions doc.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SQLITE_FILE_RELATIVE } from "../shared/constants.ts";
import { migrate } from "./migrations.ts";

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
