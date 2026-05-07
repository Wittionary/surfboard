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
import { refreshRemoteStatus } from "../../src/server/syncEngine.ts";
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
`;

function setup(): { workspaceDir: string; dbHandle: DbHandle } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-rstatus-"));
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
  writeFileSync(join(workspaceDir, "workitems", "tree.yaml"), TREE, "utf8");
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

function client(handler: (url: string) => Response): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(handler(String(url)))) as unknown as typeof fetch,
  });
}

describe("refreshRemoteStatus", () => {
  test("reports remote_changed and lists changed diagnostic fields", async () => {
    const { workspaceDir, dbHandle } = setup();
    const c = client((url) => {
      if (url.includes("/wit/workitems/100/updates")) {
        return new Response(
          JSON.stringify({
            count: 1,
            value: [
              {
                id: 1,
                rev: 7,
                fields: {
                  "System.Title": { oldValue: "Feature A", newValue: "Feature A NEW" },
                  "System.State": { oldValue: "New", newValue: "Approved" },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              id: 100,
              rev: 7,
              fields: { "System.WorkItemType": "Feature", "System.Rev": 7 },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const diag = await refreshRemoteStatus(
      { client: c, db: dbHandle.db, workspaceDir },
    );
    expect(diag.length).toBe(1);
    expect(diag[0]?.syncStatus).toBe("remote_changed");
    expect(diag[0]?.changedFields).toContain("System.Title");
    expect(diag[0]?.changedFields).toContain("System.State");
    const cached = getCachedByAdoId(dbHandle.db, 100);
    expect(cached?.lastRemoteRev).toBe(7);
    expect(cached?.syncStatus).toBe("remote_changed");
    // Last-known stays unchanged.
    expect(cached?.lastKnownRev).toBe(5);
  });

  test("reports deleted_remotely and persists status", async () => {
    const { workspaceDir, dbHandle } = setup();
    const c = client(() =>
      new Response(
        JSON.stringify({
          count: 1,
          value: [
            { id: 100, rev: 5, fields: { "System.IsDeleted": true } },
          ],
        }),
        { status: 200 },
      ),
    );
    const diag = await refreshRemoteStatus(
      { client: c, db: dbHandle.db, workspaceDir },
    );
    expect(diag[0]?.deleted).toBe(true);
    expect(diag[0]?.syncStatus).toBe("deleted_remotely");
    expect(getCachedByAdoId(dbHandle.db, 100)?.syncStatus).toBe("deleted_remotely");
  });

  test("reports synced and updates nothing when rev matches", async () => {
    const { workspaceDir, dbHandle } = setup();
    const before = getCachedByAdoId(dbHandle.db, 100);
    const c = client(() =>
      new Response(
        JSON.stringify({
          count: 1,
          value: [
            { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature" } },
          ],
        }),
        { status: 200 },
      ),
    );
    const diag = await refreshRemoteStatus(
      { client: c, db: dbHandle.db, workspaceDir },
    );
    expect(diag[0]?.syncStatus).toBe("synced");
    const after = getCachedByAdoId(dbHandle.db, 100);
    expect(after?.lastKnownRev).toBe(before?.lastKnownRev);
  });

  test("captures parent-relation change as System.Parent diagnostic", async () => {
    const { workspaceDir, dbHandle } = setup();
    const c = client((url) => {
      if (url.includes("/updates")) {
        return new Response(
          JSON.stringify({
            count: 1,
            value: [
              {
                id: 1,
                rev: 7,
                relations: {
                  added: [
                    { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/300" },
                  ],
                  removed: [
                    { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/50" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          count: 1,
          value: [{ id: 100, rev: 7, fields: { "System.WorkItemType": "Feature" } }],
        }),
        { status: 200 },
      );
    });
    const diag = await refreshRemoteStatus(
      { client: c, db: dbHandle.db, workspaceDir },
    );
    expect(diag[0]?.changedFields).toContain("System.Parent");
  });
});
