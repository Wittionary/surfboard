import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import { getCachedByAdoId, openDb, type DbHandle } from "../../src/server/db.ts";
import { pullParentAndChildren } from "../../src/server/syncEngine.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/ado");
function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-pull-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function clientFor(routes: Record<string, string | { status: number; body?: string }>): AdoClient {
  const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      for (const [pattern, response] of sorted) {
        if (u.includes(pattern)) {
          if (typeof response === "string") {
            return Promise.resolve(new Response(response, { status: 200 }));
          }
          return Promise.resolve(new Response(response.body ?? "", { status: response.status }));
        }
      }
      return Promise.resolve(new Response("not mocked", { status: 404 }));
    }) as typeof fetch,
  });
}

describe("pullParentAndChildren — create missing", () => {
  test("creates YAML files under workitems/<kind>s/ for parent and direct children", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });

    const result = await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    expect(result.status).toBe("success");
    expect(result.summary.pulled).toBe(3);
    expect(result.items.length).toBe(3);

    // YAML files exist on disk under deterministic paths.
    expect(existsSync(join(workspaceDir, "workitems", "features", "feature-221835.yaml"))).toBe(true);
    expect(existsSync(join(workspaceDir, "workitems", "pbis", "pbi-221836.yaml"))).toBe(true);
    expect(existsSync(join(workspaceDir, "workitems", "pbis", "pbi-221837.yaml"))).toBe(true);
  });

  test("YAML contains kind, metadata, and parent reference but not Rev/Tags fields", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });

    await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const docs = parseYamlFile(join(workspaceDir, "workitems", "pbis", "pbi-221836.yaml"));
    const item = docs[0]?.content;
    expect(item?.kind).toBe("PBI");
    expect(item?.metadata.adoId).toBe(221836);
    expect(item?.spec.parent?.adoId).toBe(221835);
    expect(item?.spec.fields["System.Rev"]).toBeUndefined();
    expect(item?.spec.fields["System.Tags"]).toBeUndefined();
  });

  test("cache rows store metadata + accepted baseline, never field content", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });

    await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const parent = getCachedByAdoId(dbHandle.db, 221835);
    expect(parent?.lastKnownRev).toBe(12);
    expect(parent?.lastKnownFieldHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parent?.lastKnownRelationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parent?.lastPulledAt).toBeDefined();
    expect(parent?.syncStatus).toBe("synced");

    // Confirm the field content is NOT serialized into SQLite.
    const dump = Buffer.from(dbHandle.db.serialize()).toString("utf8");
    expect(dump).not.toContain("Surfboard sandbox parent");
    expect(dump).not.toContain("Sandbox PBI A");
  });

  test("re-pulling at the same revision returns skip (no churn)", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });

    await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );
    const second = await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const skips = second.items.filter((i) => i.action === "skip");
    expect(skips.length).toBe(3);
  });

  test("blocks when remote parent is deleted", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const client = clientFor({
      "/wit/workitems/221835?": JSON.stringify({
        id: 221835,
        rev: 1,
        fields: { "System.WorkItemType": "Feature", "System.IsDeleted": true },
      }),
    });

    const result = await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    expect(result.status).toBe("blocked");
    expect(result.items[0]?.errorCode).toBe("remote_deleted");
  });

  test("propagates fetch failure as failed without writing YAML", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const client = clientFor({
      "/wit/workitems/221835?": { status: 500, body: "boom" },
    });

    const result = await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );
    expect(result.status).toBe("failed");
    expect(existsSync(join(workspaceDir, "workitems"))).toBe(false);
  });
});
