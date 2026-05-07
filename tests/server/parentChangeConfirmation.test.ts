import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import {
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

const REMOTE_PBI = {
  id: 200,
  rev: 5,
  fields: {
    "System.WorkItemType": "Product Backlog Item",
    "System.Title": "PBI A",
    "System.Rev": 5,
    "System.Parent": 100, // remote parent
  },
  relations: [
    {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: "https://dev.azure.com/goalliant/_apis/wit/workItems/100",
    },
  ],
};

const REPARENT_TREE = `apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-old
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: Old parent
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-new
  adoId: 300
spec:
  parent:
    adoId: 50
  fields:
    System.Title: New parent
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
  adoId: 200
spec:
  parent:
    localId: feature-new
    adoId: 300
  fields:
    System.Title: PBI A
`;

function setup(): { workspaceDir: string; dbHandle: DbHandle } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-reparent-"));
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
  writeFileSync(join(workspaceDir, "workitems", "tree.yaml"), REPARENT_TREE, "utf8");
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir, templateDir });
  indexWorkspace(dbHandle.db, scan);
  for (const doc of parseYamlFile(join(workspaceDir, "workitems", "tree.yaml"))) {
    const item = doc.content;
    if (!item || item.metadata.adoId === undefined) continue;
    updateAcceptedBaseline(dbHandle.db, {
      localId: item.metadata.localId,
      adoId: item.metadata.adoId,
      rev: 5,
      fieldHash: fieldHash(item),
      relationHash: relationHash(item),
      syncStatus: "synced",
    });
  }
  return { workspaceDir, dbHandle };
}

function client(handler: (url: string, init?: RequestInit) => Response): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      Promise.resolve(handler(String(url), init))) as typeof fetch,
  });
}

describe("parent-change confirmation", () => {
  test("blocks reparent without explicit confirmation", async () => {
    const { workspaceDir, dbHandle } = setup();
    let patchCalls = 0;
    const c = client((_url, init) => {
      if (init?.method === "PATCH") patchCalls += 1;
      // Remote returns the new feature unchanged so its rev matches; the PBI
      // returns parent=100 (old parent), so detectReparent fires.
      return new Response(
        JSON.stringify({
          count: 3,
          value: [
            { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            { id: 300, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            REMOTE_PBI,
          ],
        }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-new" }, includeParent: false, childLocalIds: ["pbi-a"] },
    );
    const pbiResult = result.items.find((i) => i.localId === "pbi-a");
    expect(pbiResult?.status).toBe("requires_confirmation");
    expect(pbiResult?.confirmationRequired).toBe("change_parent");
    expect(patchCalls).toBe(0);
  });

  test("allows reparent when confirmedParentChanges includes the local id", async () => {
    const { workspaceDir, dbHandle } = setup();
    let patchBody = "";
    const c = client((_url, init) => {
      if (init?.method === "PATCH") {
        patchBody = String(init.body);
        return new Response(
          JSON.stringify({ id: 200, rev: 6, fields: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          count: 3,
          value: [
            { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            { id: 300, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            REMOTE_PBI,
          ],
        }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      {
        parent: { localId: "feature-new" },
        includeParent: false,
        childLocalIds: ["pbi-a"],
        confirmedParentChanges: ["pbi-a"],
      },
    );
    const pbi = result.items.find((i) => i.localId === "pbi-a");
    expect(pbi?.status).toBe("success");
    // Patch body should include a remove + add for the relation.
    const ops = JSON.parse(patchBody) as Array<{ op: string; path: string; value?: unknown }>;
    expect(ops.some((o) => o.op === "remove" && o.path.startsWith("/relations/"))).toBe(true);
    expect(ops.some((o) => o.op === "add" && o.path === "/relations/-")).toBe(true);
  });

  test("confirmation does not bypass remote rev check", async () => {
    const { workspaceDir, dbHandle } = setup();
    const c = client((_url, init) => {
      if (init?.method === "PATCH") return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({
          count: 3,
          value: [
            { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            { id: 300, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
            { ...REMOTE_PBI, rev: 99, fields: { ...REMOTE_PBI.fields, "System.Rev": 99 } },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      {
        parent: { localId: "feature-new" },
        includeParent: false,
        childLocalIds: ["pbi-a"],
        confirmedParentChanges: ["pbi-a"],
      },
    );
    expect(result.status).toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "remote_revision_changed")).toBe(true);
  });
});
