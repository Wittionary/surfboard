import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import {
  getCachedByAdoId,
  openDb,
  updateAcceptedBaseline,
  type DbHandle,
} from "../../src/server/db.ts";
import { fieldHash, relationHash } from "../../src/server/hash.ts";
import { pushParentAndChildren } from "../../src/server/syncEngine.ts";
import { scanWorkspace, indexWorkspace } from "../../src/server/workspace.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");
const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeTree(yaml: string): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-create-"));
  tempDirs.push(workspaceDir);
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
  mkdirSync(join(workspaceDir, "workitems"), { recursive: true });
  writeFileSync(join(workspaceDir, "workitems", "tree.yaml"), yaml, "utf8");
  return { workspaceDir, templateDir };
}

function setup(yaml: string): {
  workspaceDir: string;
  dbHandle: DbHandle;
} {
  const { workspaceDir, templateDir } = makeTree(yaml);
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir, templateDir });
  indexWorkspace(dbHandle.db, scan);
  // Seed baselines for items with adoId so existing-item checks pass.
  const docs = parseYamlFile(join(workspaceDir, "workitems", "tree.yaml"));
  for (const doc of docs) {
    const item = doc.content;
    if (!item || item.metadata.adoId === undefined) continue;
    updateAcceptedBaseline(dbHandle.db, {
      localId: item.metadata.localId,
      adoId: item.metadata.adoId,
      rev: 1,
      fieldHash: fieldHash(item),
      relationHash: relationHash(item),
      syncStatus: "synced",
    });
  }
  return { workspaceDir, dbHandle };
}

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      Promise.resolve(handler(String(url), init))) as typeof fetch,
  });
}

describe("push create child", () => {
  test("creates a PBI under an existing Feature, updates YAML metadata.adoId, and records baseline", async () => {
    const { workspaceDir, dbHandle } = setup(`
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-a
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: Feature A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-new
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: New PBI
`);
    let lastPatchUrl = "";
    let lastPatchBody = "";
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        lastPatchUrl = url;
        lastPatchBody = String(init.body);
        return new Response(
          JSON.stringify({ id: 12345, rev: 1, fields: { "System.Title": "New PBI" } }),
          { status: 200 },
        );
      }
      // No existing items to fetch.
      return new Response(JSON.stringify({ count: 0, value: [] }), { status: 200 });
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(result.status).toBe("success");
    expect(result.summary.created).toBe(1);
    expect(result.summary.updated).toBe(0);
    expect(result.summary.pulled).toBe(0);
    const created = result.items.find((i) => i.action === "create");
    expect(created?.localId).toBe("pbi-new");
    expect(created?.adoId).toBe(12345);

    // Patch URL targets the PBI work-item-create endpoint.
    expect(lastPatchUrl).toContain("/wit/workitems/$Product%20Backlog%20Item");
    // Patch body includes parent relation Hierarchy-Reverse.
    expect(lastPatchBody).toContain("Hierarchy-Reverse");

    // YAML now has the new ADO ID.
    const docs = parseYamlFile(join(workspaceDir, "workitems", "tree.yaml"));
    const persistedPbi = docs.find((d) => d.content?.metadata.localId === "pbi-new")?.content;
    expect(persistedPbi?.metadata.adoId).toBe(12345);

    // Cache row recorded the rev.
    const cached = getCachedByAdoId(dbHandle.db, 12345);
    expect(cached?.lastKnownRev).toBe(1);
    expect(cached?.syncStatus).toBe("synced");
  });

  test("creates a Task under a PBI", async () => {
    const { workspaceDir, dbHandle } = setup(`
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-existing
  adoId: 200
spec:
  parent:
    adoId: 100
  fields:
    System.Title: Existing PBI
---
apiVersion: surfboard.ado/v1
kind: Task
metadata:
  localId: task-new
spec:
  parent:
    localId: pbi-existing
    adoId: 200
  fields:
    System.Title: New Task
`);
    let createdAdoId = 0;
    const c = client((url, init) => {
      if (init?.method === "PATCH" && url.includes("$Task")) {
        createdAdoId = 555;
        return new Response(
          JSON.stringify({ id: 555, rev: 1, fields: { "System.Title": "New Task" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ count: 0, value: [] }), { status: 200 });
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "pbi-existing" } },
    );
    expect(result.status).toBe("success");
    expect(createdAdoId).toBe(555);
  });

  test("creates child orphaned in ADO when parent has no adoId yet (warns but does not block)", async () => {
    // Feature has no adoId — under MVP scope, parent creation is not auto-pushed.
    // The PBI is still pushable; ADO accepts it without a Hierarchy-Reverse
    // link. The validator's missing_parent / missing_parent_ado_id warnings
    // already surfaced this via /api/validate.
    const { workspaceDir, dbHandle } = setup(`
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-new
spec:
  parent:
    adoId: 50
  fields:
    System.Title: Feature New
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-new
spec:
  parent:
    localId: feature-new
  fields:
    System.Title: PBI new
`);
    let createBody: unknown = null;
    let createdAdoId = 0;
    const c = client((_url, init) => {
      if (init?.method === "PATCH") {
        createBody = JSON.parse(String(init.body));
        createdAdoId = 777;
        return new Response(JSON.stringify({ id: 777, rev: 1, fields: {} }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-new" } },
    );
    expect(result.status).toBe("success");
    expect(createdAdoId).toBe(777);
    // Patch must not include a Hierarchy-Reverse relation since parent has no ADO ID.
    const ops = createBody as Array<{ op: string; path: string }>;
    expect(ops.some((o) => o.path === "/relations/-")).toBe(false);
  });

  test("create patch includes defaulted fields when authored YAML omits them", async () => {
    const { workspaceDir, dbHandle } = setup(`
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-a
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: Feature A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-new
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: New PBI
`);
    // Inject a defaults file into the workspace's templates/ dir.
    writeFileSync(
      join(workspaceDir, "templates", "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: Alliant
  kinds:
    PBI:
      fields:
        Microsoft.VSTS.Common.Priority: 2
`,
      "utf8",
    );

    let createBody: Array<{ op: string; path: string; value?: unknown }> = [];
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        createBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ id: 12345, rev: 1, fields: {} }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ count: 0, value: [] }), { status: 200 });
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(result.status).toBe("success");
    const areaPathOp = createBody.find((o) => o.path === "/fields/System.AreaPath");
    expect(areaPathOp?.value).toBe("Alliant");
    const priorityOp = createBody.find(
      (o) => o.path === "/fields/Microsoft.VSTS.Common.Priority",
    );
    expect(priorityOp?.value).toBe(2);
  });
});
