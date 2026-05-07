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

const REMOTE_FEATURE = {
  id: 100, rev: 5,
  fields: { "System.WorkItemType": "Feature", "System.Title": "F", "System.Rev": 5, "System.Parent": 50 },
};
const REMOTE_PBI_ALPHA = {
  id: 200, rev: 5,
  fields: { "System.WorkItemType": "Product Backlog Item", "System.Title": "alpha", "System.Rev": 5, "System.Parent": 100 },
};
const REMOTE_PBI_BRAVO = {
  id: 201, rev: 5,
  fields: { "System.WorkItemType": "Product Backlog Item", "System.Title": "bravo", "System.Rev": 5, "System.Parent": 100 },
};

const TREE = `apiVersion: surfboard.ado/v1
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
  localId: pbi-alpha
  adoId: 200
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: alpha edited
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-bravo
  adoId: 201
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: bravo edited
`;

function setup(yaml = TREE): { workspaceDir: string; dbHandle: DbHandle } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-batch-"));
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

describe("push batch ordering and stop-on-first-failure", () => {
  test("parent updates first; children updated in localId order", async () => {
    const { workspaceDir, dbHandle } = setup();
    const order: number[] = [];
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        const m = url.match(/workitems\/(\d+)/);
        if (m && m[1]) order.push(Number.parseInt(m[1], 10));
        return new Response(
          JSON.stringify({ id: 100, rev: 6, fields: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ count: 3, value: [REMOTE_FEATURE, REMOTE_PBI_ALPHA, REMOTE_PBI_BRAVO] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("success");
    expect(order[0]).toBe(100);
    expect(order.slice(1)).toEqual([200, 201]);
  });

  test("stops on first failure; later operations are not attempted", async () => {
    const { workspaceDir, dbHandle } = setup();
    let attempts = 0;
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        attempts += 1;
        if (url.includes("/100")) {
          return new Response("boom", { status: 500, statusText: "Server Error" });
        }
        return new Response(JSON.stringify({ id: 0, rev: 6, fields: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ count: 3, value: [REMOTE_FEATURE, REMOTE_PBI_ALPHA, REMOTE_PBI_BRAVO] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("partial_failure");
    // Only the parent attempt happened — children never tried.
    expect(attempts).toBe(1);
  });

  test("blocks an item when its YAML changes between plan and execution", async () => {
    const { workspaceDir, dbHandle } = setup();
    const treePath = join(workspaceDir, "workitems", "tree.yaml");

    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        // Side-effect: mutate the YAML file before the patch returns so the
        // next iteration sees a different file hash.
        if (url.includes("/100")) {
          writeFileSync(treePath, `${TREE}\n# trailing edit\n`, "utf8");
        }
        return new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ count: 3, value: [REMOTE_FEATURE, REMOTE_PBI_ALPHA, REMOTE_PBI_BRAVO] }),
        { status: 200 },
      );
    });

    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(
      result.items.some((i) => i.errorCode === "yaml_changed_during_push"),
    ).toBe(true);
  });
});
