import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import type { ScaffoldChildResponse } from "../../src/server/routes.ts";

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

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-scaffold-"));
  tempDirs.push(workspaceDir);
  const templateDir = join(workspaceDir, "templates");
  mkdirSync(templateDir, { recursive: true });
  for (const name of ["epic.schema.yaml", "feature.schema.yaml", "pbi.schema.yaml", "enabler.schema.yaml", "task.schema.yaml"]) {
    copyFileSync(join(FIXTURE_TEMPLATES, name), join(templateDir, name));
  }
  mkdirSync(join(workspaceDir, "workitems"), { recursive: true });
  return { workspaceDir, templateDir };
}

function seedItems(workspaceDir: string): void {
  writeFileSync(
    join(workspaceDir, "workitems", "family.yaml"),
    `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: epic-1
  adoId: 100
spec:
  fields:
    System.Title: Platform Epic
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-1
  adoId: 101
spec:
  parent:
    localId: epic-1
    adoId: 100
  fields:
    System.Title: Some Feature
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-1
  adoId: 102
spec:
  parent:
    localId: feature-1
    adoId: 101
  fields:
    System.Title: Some PBI
---
apiVersion: surfboard.ado/v1
kind: Enabler
metadata:
  localId: enabler-1
  adoId: 103
spec:
  parent:
    localId: feature-1
    adoId: 101
  fields:
    System.Title: Some Enabler
---
apiVersion: surfboard.ado/v1
kind: Task
metadata:
  localId: task-1
  adoId: 104
spec:
  parent:
    localId: pbi-1
    adoId: 102
  fields:
    System.Title: Some Task
`,
    "utf8",
  );
}

function setup(): { app: ReturnType<typeof buildAppHandle>["fastify"] } {
  const ws = makeWorkspace();
  seedItems(ws.workspaceDir);
  const config = loadConfig({ env: { ADO_WORKSPACE_DIR: ws.workspaceDir, ADO_TEMPLATE_DIR: ws.templateDir } });
  const dbHandle = openDb({ workspaceDir: ws.workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null });
  return { app: handle.fastify };
}

async function post(app: ReturnType<typeof buildAppHandle>["fastify"], body: unknown) {
  return app.inject({ method: "POST", url: "/api/scaffold/child", payload: body, headers: { "content-type": "application/json" } });
}

describe("POST /api/scaffold/child", () => {
  test("creates a PBI stub child for a Feature parent (default)", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "feature-1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScaffoldChildResponse;
    expect(body.workItemType).toBe("PBI");
    expect(body.localId).toMatch(/^pbi-[0-9a-f]{8}$/);
    expect(body.yamlPath).toContain("family.yaml");
  });

  test("creates a Feature stub for an Epic parent", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "epic-1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScaffoldChildResponse;
    expect(body.workItemType).toBe("Feature");
    expect(body.localId).toMatch(/^feature-[0-9a-f]{8}$/);
  });

  test("creates a Task stub for a PBI parent", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "pbi-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ScaffoldChildResponse).workItemType).toBe("Task");
  });

  test("creates a Task stub for an Enabler parent", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "enabler-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ScaffoldChildResponse).workItemType).toBe("Task");
  });

  test("stub has correct title, parent localId, and parent adoId", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "feature-1" } });
    const body = res.json() as ScaffoldChildResponse;
    const yaml = readFileSync(body.yamlPath, "utf8");
    expect(yaml).toContain("System.Title: New PBI");
    expect(yaml).toContain("localId: feature-1");
    expect(yaml).toContain("adoId: 101");
  });

  test("stub is appended to the parent YAML file, not a new file", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "pbi-1" } });
    const body = res.json() as ScaffoldChildResponse;
    expect(body.yamlPath).toContain("family.yaml");
    expect(body.yamlDocumentIndex).toBeGreaterThan(0);
  });

  test("stub localIds are unique across two consecutive calls", async () => {
    const { app } = setup();
    const r1 = (await post(app, { parent: { localId: "feature-1" } })).json() as ScaffoldChildResponse;
    const r2 = (await post(app, { parent: { localId: "feature-1" } })).json() as ScaffoldChildResponse;
    expect(r1.localId).not.toBe(r2.localId);
  });

  test("accepts parent selector by adoId", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { adoId: 101 } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ScaffoldChildResponse).workItemType).toBe("PBI");
  });

  test("404 when parent not found in workspace", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "no-such-item" } });
    expect(res.statusCode).toBe(404);
  });

  test("400 when Task parent has no valid child type", async () => {
    const { app } = setup();
    const res = await post(app, { parent: { localId: "task-1" } });
    expect(res.statusCode).toBe(400);
  });

  test("400 when parent selector is missing", async () => {
    const { app } = setup();
    const res = await post(app, { parent: {} });
    expect(res.statusCode).toBe(400);
  });
});
