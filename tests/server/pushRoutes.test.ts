import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import {
  openDb,
  updateAcceptedBaseline,
  type DbHandle,
} from "../../src/server/db.ts";
import { fieldHash, relationHash } from "../../src/server/hash.ts";
import { scanWorkspace, indexWorkspace } from "../../src/server/workspace.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";
import type { OperationResult } from "../../src/shared/types.ts";

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

function setup(routes: Record<string, (init?: RequestInit) => Response>): {
  app: ReturnType<typeof buildAppHandle>["fastify"];
  workspaceDir: string;
} {
  const ws = mkdtempSync(join(tmpdir(), "surfboard-push-routes-"));
  tempDirs.push(ws);
  const templateDir = join(ws, "templates");
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
  mkdirSync(join(ws, "workitems"), { recursive: true });
  writeFileSync(join(ws, "workitems", "tree.yaml"), TREE, "utf8");

  const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir: ws, templateDir });
  indexWorkspace(dbHandle.db, scan);
  for (const doc of parseYamlFile(join(ws, "workitems", "tree.yaml"))) {
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

  const config = loadConfig({
    env: {
      ADO_ORG: "goalliant",
      ADO_PROJECT: "Alliant",
      ADO_PAT: "secret-test-pat",
      ADO_WORKSPACE_DIR: ws,
      ADO_TEMPLATE_DIR: templateDir,
    },
  });

  const sortedRoutes = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    for (const [pattern, handler] of sortedRoutes) {
      if (u.includes(pattern)) return Promise.resolve(handler(init));
    }
    return Promise.resolve(new Response("not mocked", { status: 404 }));
  }) as typeof fetch;
  const adoClient = new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "secret-test-pat",
    fetchImpl,
  });
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient });
  return { app: handle.fastify, workspaceDir: ws };
}

const REMOTE_BATCH = JSON.stringify({
  count: 2,
  value: [
    { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 50 } },
    { id: 200, rev: 5, fields: { "System.WorkItemType": "Product Backlog Item", "System.Rev": 5, "System.Parent": 100 } },
  ],
});

describe("POST /api/push/all", () => {
  test("returns success and updated counts when patches succeed", async () => {
    const { app } = setup({
      "/wit/workitems/100": (init) =>
        init?.method === "PATCH"
          ? new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 })
          : new Response("not mocked", { status: 404 }),
      "/wit/workitems/200": (init) =>
        init?.method === "PATCH"
          ? new Response(JSON.stringify({ id: 200, rev: 6, fields: {} }), { status: 200 })
          : new Response("not mocked", { status: 404 }),
      "/wit/workitems": () => new Response(REMOTE_BATCH, { status: 200 }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ parent: { localId: "feature-a" }, includeParent: true }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OperationResult;
    expect(body.status).toBe("success");
    await app.close();
  });

  test("returns blocked when remote rev mismatches", async () => {
    const { app } = setup({
      "/wit/workitems": () =>
        new Response(
          JSON.stringify({
            count: 2,
            value: [
              { id: 100, rev: 99, fields: { "System.WorkItemType": "Feature", "System.Rev": 99, "System.Parent": 50 } },
              { id: 200, rev: 5, fields: { "System.WorkItemType": "Product Backlog Item", "System.Rev": 5, "System.Parent": 100 } },
            ],
          }),
          { status: 200 },
        ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ parent: { localId: "feature-a" }, includeParent: true }),
    });
    const body = res.json() as OperationResult;
    expect(body.status).toBe("blocked");
    expect(body.items.some((i) => i.errorCode === "remote_revision_changed")).toBe(true);
    await app.close();
  });

  test("returns 400 when parent selector is missing", async () => {
    const { app } = setup({});
    const res = await app.inject({
      method: "POST",
      url: "/api/push/all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ parent: {} }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/push/item", () => {
  test("pushes a single existing item with /rev test op", async () => {
    let body = "";
    const { app } = setup({
      "/wit/workitems/100": (init) => {
        if (init?.method === "PATCH") {
          body = String(init.body);
          return new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 });
        }
        return new Response("not mocked", { status: 404 });
      },
      "/wit/workitems": () => new Response(REMOTE_BATCH, { status: 200 }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/item",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ item: { localId: "feature-a" } }),
    });
    expect(res.statusCode).toBe(200);
    const ops = JSON.parse(body) as Array<{ op: string; path: string; value?: unknown }>;
    expect(ops[0]).toEqual({ op: "test", path: "/rev", value: 5 });
    await app.close();
  });

  test("returns 400 when item selector is missing", async () => {
    const { app } = setup({});
    const res = await app.inject({
      method: "POST",
      url: "/api/push/item",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ item: {} }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
