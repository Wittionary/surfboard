import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import type {
  ParentViewResponse,
  ValidateResponse,
  WorkspaceStatusResponse,
} from "../../src/server/routes.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-routes-"));
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
  return { workspaceDir, templateDir };
}

function seedFamily(workspaceDir: string): void {
  const items = join(workspaceDir, "workitems");
  mkdirSync(items, { recursive: true });
  writeFileSync(
    join(items, "epic.yaml"),
    `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: epic-platform-reliability
  adoId: 200000
spec:
  fields:
    System.Title: Platform reliability
    System.State: Approved
`,
    "utf8",
  );
  writeFileSync(
    join(items, "feature.yaml"),
    `apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-observability-refresh
  adoId: 200001
spec:
  parent:
    localId: epic-platform-reliability
    adoId: 200000
  fields:
    System.Title: Observability refresh
    System.State: New
`,
    "utf8",
  );
  writeFileSync(
    join(items, "pbi.yaml"),
    `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-dashboard
  adoId: 200002
spec:
  parent:
    localId: feature-observability-refresh
    adoId: 200001
  fields:
    System.Title: Dashboard latency
    Microsoft.VSTS.Common.Priority: 2
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-alerts
spec:
  parent:
    localId: feature-observability-refresh
    adoId: 200001
  fields:
    System.Title: Alert rules
`,
    "utf8",
  );
}

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function setup(): {
  app: ReturnType<typeof buildAppHandle>["fastify"];
  workspace: { workspaceDir: string; templateDir: string };
} {
  const ws = makeWorkspace();
  seedFamily(ws.workspaceDir);
  const config = loadConfig({
    env: { ADO_WORKSPACE_DIR: ws.workspaceDir, ADO_TEMPLATE_DIR: ws.templateDir },
  });
  const dbHandle = openDb({ workspaceDir: ws.workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null });
  return { app: handle.fastify, workspace: ws };
}

describe("/api/workspace/status and /refresh", () => {
  test("status returns counts after refresh", async () => {
    const { app, workspace } = setup();
    await app.inject({ method: "POST", url: "/api/workspace/refresh" });
    const res = await app.inject({ method: "GET", url: "/api/workspace/status" });
    const body = res.json() as WorkspaceStatusResponse;
    expect(res.statusCode).toBe(200);
    expect(body.workspaceDir).toBe(workspace.workspaceDir);
    expect(body.templateDir).toBe(workspace.templateDir);
    expect(body.documentCount).toBe(4); // epic + feature + 2 PBIs
    expect(body.validItemCount).toBe(4);
    expect(typeof body.refreshedAt).toBe("string");
    await app.close();
  });
});

describe("/api/validate", () => {
  test("scope=workspace returns aggregate issues", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/validate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "workspace" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ValidateResponse;
    expect(body.scope).toBe("workspace");
    expect(body.itemCount).toBe(4);
    expect(Array.isArray(body.issues)).toBe(true);
    await app.close();
  });

  test("scope=item returns only that item's issues", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/validate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "item", item: { localId: "pbi-dashboard" } }),
    });
    const body = res.json() as ValidateResponse;
    expect(body.itemCount).toBe(1);
    await app.close();
  });

  test("scope=displayed returns parent + direct children", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/validate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        scope: "displayed",
        parent: { localId: "feature-observability-refresh" },
      }),
    });
    const body = res.json() as ValidateResponse;
    expect(body.itemCount).toBe(3); // feature + 2 PBIs
    await app.close();
  });

  test("rejects invalid scope", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/validate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "nope" }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("/api/view/parent/:localId", () => {
  test("returns parent and its direct children", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/view/parent/feature-observability-refresh",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ParentViewResponse;
    expect(body.parent.localId).toBe("feature-observability-refresh");
    expect(body.parent.title).toBe("Observability refresh");
    expect(body.parent.workItemType).toBe("Feature");
    const childIds = body.children.map((c) => c.localId).sort();
    expect(childIds).toEqual(["pbi-alerts", "pbi-dashboard"]);
    await app.close();
  });

  test("returns 404 for unknown parent", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/view/parent/ghost" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test("matches children whose parent.adoId points at the parent's ADO ID even without localId", async () => {
    const { app, workspace } = setup();
    // Add a child that references parent only by adoId.
    writeFileSync(
      join(workspace.workspaceDir, "workitems", "extra.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-extra
spec:
  parent:
    adoId: 200001
  fields:
    System.Title: Extra
`,
      "utf8",
    );
    await app.inject({ method: "POST", url: "/api/workspace/refresh" });
    const res = await app.inject({
      method: "GET",
      url: "/api/view/parent/feature-observability-refresh",
    });
    const body = res.json() as ParentViewResponse;
    expect(body.children.map((c) => c.localId).sort()).toEqual([
      "pbi-alerts",
      "pbi-dashboard",
      "pbi-extra",
    ]);
    await app.close();
  });
});
