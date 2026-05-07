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

function makeWorkspace(yaml: string): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-push-rs-"));
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

function setupBaselineAt(rev: number): {
  workspaceDir: string;
  dbHandle: DbHandle;
  parentLocalId: string;
} {
  const yaml = `apiVersion: surfboard.ado/v1
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
  localId: pbi-a
  adoId: 200
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: PBI A
`;
  const { workspaceDir, templateDir } = makeWorkspace(yaml);
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir, templateDir });
  indexWorkspace(dbHandle.db, scan);

  // Seed baseline so prevalidation passes.
  for (const file of [join(workspaceDir, "workitems", "tree.yaml")]) {
    const docs = parseYamlFile(file);
    for (const doc of docs) {
      const item = doc.content;
      if (!item || item.metadata.adoId === undefined) continue;
      updateAcceptedBaseline(dbHandle.db, {
        localId: item.metadata.localId,
        adoId: item.metadata.adoId,
        rev,
        fieldHash: fieldHash(item),
        relationHash: relationHash(item),
        syncStatus: "synced",
      });
    }
  }
  return { workspaceDir, dbHandle, parentLocalId: "feature-a" };
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
}

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: fakeFetch(handler),
  });
}

describe("push remote safety", () => {
  test("blocks when remote rev advanced past cached baseline", async () => {
    const setup = setupBaselineAt(5);
    const c = client((url) => {
      if (url.includes("/wit/workitems") && url.includes("ids=")) {
        return new Response(
          JSON.stringify({
            count: 2,
            value: [
              {
                id: 100,
                rev: 99,
                fields: { "System.WorkItemType": "Feature", "System.Title": "Feature A", "System.Rev": 99 },
              },
              {
                id: 200,
                rev: 5,
                fields: { "System.WorkItemType": "Product Backlog Item", "System.Title": "PBI A", "System.Rev": 5 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    });
    const result = await pushParentAndChildren(
      { client: c, db: setup.dbHandle.db, workspaceDir: setup.workspaceDir },
      { parent: { localId: setup.parentLocalId }, includeParent: true },
    );
    expect(result.status).toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "remote_revision_changed")).toBe(true);
    // Cache should record the observed remote rev.
    const cached = getCachedByAdoId(setup.dbHandle.db, 100);
    expect(cached?.lastRemoteRev).toBe(99);
    expect(cached?.syncStatus).toBe("remote_changed");
  });

  test("blocks when remote item is deleted", async () => {
    const setup = setupBaselineAt(5);
    const c = client(() =>
      new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              id: 100,
              rev: 5,
              fields: { "System.IsDeleted": true },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await pushParentAndChildren(
      { client: c, db: setup.dbHandle.db, workspaceDir: setup.workspaceDir },
      { parent: { localId: setup.parentLocalId }, includeParent: true },
    );
    expect(result.status).toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "remote_deleted")).toBe(true);
  });

  test("does not submit any update patch when blocked by rev mismatch", async () => {
    const setup = setupBaselineAt(5);
    let patchCalls = 0;
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        patchCalls += 1;
        return new Response("{}", { status: 200 });
      }
      // Remote rev mismatch.
      return new Response(
        JSON.stringify({
          count: 2,
          value: [
            {
              id: 100,
              rev: 99,
              fields: { "System.WorkItemType": "Feature", "System.Title": "X", "System.Rev": 99 },
            },
            {
              id: 200,
              rev: 5,
              fields: { "System.WorkItemType": "Product Backlog Item", "System.Title": "Y", "System.Rev": 5 },
            },
          ],
        }),
        { status: 200 },
      );
    });
    await pushParentAndChildren(
      { client: c, db: setup.dbHandle.db, workspaceDir: setup.workspaceDir },
      { parent: { localId: setup.parentLocalId }, includeParent: true },
    );
    expect(patchCalls).toBe(0);
  });

  test("does not block when remote rev matches cached baseline", async () => {
    const setup = setupBaselineAt(5);
    let patchCalls = 0;
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        patchCalls += 1;
        return new Response(
          JSON.stringify({ id: 100, rev: 6, fields: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          count: 2,
          value: [
            {
              id: 100,
              rev: 5,
              fields: {
                "System.WorkItemType": "Feature",
                "System.Title": "Feature A",
                "System.Rev": 5,
                "System.Parent": 50,
              },
            },
            {
              id: 200,
              rev: 5,
              fields: {
                "System.WorkItemType": "Product Backlog Item",
                "System.Title": "PBI A",
                "System.Rev": 5,
                "System.Parent": 100,
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: setup.dbHandle.db, workspaceDir: setup.workspaceDir },
      { parent: { localId: setup.parentLocalId }, includeParent: true },
    );
    expect(result.status).toBe("success");
    expect(patchCalls).toBe(2);
  });
});
