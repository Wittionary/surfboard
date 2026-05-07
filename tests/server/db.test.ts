import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/db.ts";
import { getCurrentVersion, migrate, MIGRATIONS } from "../../src/server/migrations.ts";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("openDb / migrate", () => {
  test("creates schema at the latest migration version", () => {
    const ws = makeTempWorkspace();
    const handle = openDb({ workspaceDir: ws });

    expect(getCurrentVersion(handle.db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

    const tables = handle.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    for (const expected of [
      "audit_log",
      "schema_version",
      "settings",
      "webhook_events",
      "work_item_cache",
    ]) {
      expect(tableNames).toContain(expected);
    }

    handle.close();
  });

  test("migrate is idempotent — running twice applies no migrations the second time", () => {
    const ws = makeTempWorkspace();
    const handle = openDb({ workspaceDir: ws });

    const result = migrate(handle.db);
    expect(result.applied).toEqual([]);
    expect(result.from).toBe(result.to);

    handle.close();
  });

  test("ado_id is unique when present, NULL allowed multiple times", () => {
    const handle = openDb({ workspaceDir: "ignored", path: ":memory:" });
    const insertWithAdoId = (localId: string, adoId: number | null): void => {
      handle.db.run(
        `INSERT INTO work_item_cache
          (local_id, ado_id, work_item_type, yaml_path, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [localId, adoId, "PBI", "p.yaml", "local_only", "now", "now"],
      );
    };

    insertWithAdoId("a", null);
    insertWithAdoId("b", null);
    insertWithAdoId("c", 12345);
    expect(() => insertWithAdoId("d", 12345)).toThrow();

    handle.close();
  });

  test("schema_version row exists for migration 1", () => {
    const handle = openDb({ workspaceDir: "ignored", path: ":memory:" });
    const row = handle.db.query("SELECT version, applied_at FROM schema_version WHERE version = 1").get() as
      | { version: number; applied_at: string }
      | null;
    expect(row?.version).toBe(1);
    expect(typeof row?.applied_at).toBe("string");
    handle.close();
  });

  test("creates the .surfboard directory under the workspace", () => {
    const ws = makeTempWorkspace();
    const handle = openDb({ workspaceDir: ws });
    const expectedPath = join(ws, ".surfboard", "surfboard.db");
    expect(handle.path).toBe(expectedPath);
    handle.close();
  });
});
