import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import { writeAuditEntry } from "../../src/server/audit.ts";

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const SECRET = "fake-pat-XYZ-abc";

function setup(): { app: ReturnType<typeof buildAppHandle>["fastify"]; dbHandle: DbHandle } {
  const ws = mkdtempSync(join(tmpdir(), "surfboard-audit-"));
  tempDirs.push(ws);
  writeFileSync(join(ws, "p"), "", "utf8");
  const config = loadConfig({ env: { ADO_WORKSPACE_DIR: ws, ADO_TEMPLATE_DIR: ws } });
  const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
  dbHandles.push(dbHandle);

  // Seed a few audit rows.
  for (let i = 0; i < 3; i += 1) {
    writeAuditEntry(
      dbHandle.db,
      {
        operationId: `op-${i}`,
        action: i === 1 ? "fail" : "create",
        success: i !== 1,
        localId: i === 2 ? "feature-a" : "pbi-x",
        adoId: 100 + i,
        beforeRev: 5,
        afterRev: 6,
        errorMessage: i === 1 ? `error using ${SECRET}` : undefined,
        requestSummary: { selector: { localId: "x" } },
        responseSummary: { rev: 6 },
      },
      { pat: SECRET },
    );
  }

  const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient: null });
  return { app: handle.fastify, dbHandle };
}

describe("/api/audit/recent", () => {
  test("returns redacted recent rows with limit", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/audit/recent?limit=2" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ errorMessage: string | null; localId: string | null }> };
    expect(body.items.length).toBe(2);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED_PAT]");
    await app.close();
  });

  test("default limit returns up to 50 rows", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/audit/recent" });
    const body = res.json() as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("/api/audit/item/:localId", () => {
  test("returns rows for the requested local id only", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/audit/item/feature-a" });
    const body = res.json() as { items: Array<{ localId: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.localId).toBe("feature-a");
    await app.close();
  });

  test("returns empty list for unknown local id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/audit/item/ghost" });
    const body = res.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
    await app.close();
  });
});
