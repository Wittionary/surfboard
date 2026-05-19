import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import { getCachedByAdoId, openDb, type DbHandle } from "../../src/server/db.ts";
import { pullParentAndChildren } from "../../src/server/syncEngine.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");

function seedTemplatesWithDefaults(workspaceDir: string, defaultsYaml: string): void {
  const templateDir = join(workspaceDir, "templates");
  mkdirSync(templateDir, { recursive: true });
  for (const name of [
    "epic.schema.yaml",
    "feature.schema.yaml",
    "pbi.schema.yaml",
    "enabler.schema.yaml",
    "task.schema.yaml",
  ]) {
    copyFileSync(join(FIXTURE_TEMPLATES, name), join(templateDir, name));
  }
  writeFileSync(join(templateDir, "defaults.yaml"), defaultsYaml, "utf8");
}

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
    expect(second.summary.pulled).toBe(0);
    expect(second.summary.created).toBe(0);
    expect(second.summary.updated).toBe(0);
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

  test("pull-created YAML omits a field whose value matches the applicable default", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    // The fixture sets Microsoft.VSTS.Common.Priority=2 on pbi-221836 and omits
    // it on pbi-221837. With a PBI default of priority=2, the first PBI's
    // priority should be omitted from YAML while the second stays as-is.
    seedTemplatesWithDefaults(
      workspaceDir,
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    PBI:
      fields:
        Microsoft.VSTS.Common.Priority: 2
`,
    );
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

    const pbi36 = parseYamlFile(
      join(workspaceDir, "workitems", "pbis", "pbi-221836.yaml"),
    )[0]?.content;
    expect(pbi36?.spec.fields["Microsoft.VSTS.Common.Priority"]).toBeUndefined();
    expect(pbi36?.spec.fields["System.Title"]).toBe("Sandbox PBI A");

    // pbi-221837 has no priority remotely, so nothing to omit; it stays sparse.
    const pbi37 = parseYamlFile(
      join(workspaceDir, "workitems", "pbis", "pbi-221837.yaml"),
    )[0]?.content;
    expect(pbi37?.spec.fields["Microsoft.VSTS.Common.Priority"]).toBeUndefined();
  });

  test("pull-created YAML keeps a field whose value differs from the default", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    // Default priority is 3; the remote PBI has priority 2, so it must be kept.
    seedTemplatesWithDefaults(
      workspaceDir,
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    PBI:
      fields:
        Microsoft.VSTS.Common.Priority: 3
`,
    );
    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const pbi36 = parseYamlFile(
      join(workspaceDir, "workitems", "pbis", "pbi-221836.yaml"),
    )[0]?.content;
    expect(pbi36?.spec.fields["Microsoft.VSTS.Common.Priority"]).toBe(2);
  });

  test("baselines after pull are stable: a refreshed scan sees synced status when YAML omits defaulted values", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    seedTemplatesWithDefaults(
      workspaceDir,
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    PBI:
      fields:
        Microsoft.VSTS.Common.Priority: 2
`,
    );
    const client = clientFor({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    // Re-index from disk and confirm pbi-221836 (which now omits priority)
    // is still considered synced — the baseline used effective hash.
    const { indexWorkspace, scanWorkspace } = await import("../../src/server/workspace.ts");
    const scan = scanWorkspace({
      workspaceDir,
      templateDir: join(workspaceDir, "templates"),
    });
    indexWorkspace(dbHandle.db, scan);
    const cached = getCachedByAdoId(dbHandle.db, 221836);
    expect(cached?.syncStatus).toBe("synced");
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
