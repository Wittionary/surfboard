// Spec §19.3 acceptance: local-only validation failures. No ADO involvement.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import type { ValidateResponse } from "../../src/shared/api.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");
const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-acceptance-"));
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
  return { workspaceDir, templateDir };
}

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

async function validate(workspaceDir: string, templateDir: string): Promise<ValidateResponse> {
  const config = loadConfig({
    env: { ADO_WORKSPACE_DIR: workspaceDir, ADO_TEMPLATE_DIR: templateDir },
  });
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null });
  await handle.fastify.inject({ method: "POST", url: "/api/workspace/refresh" });
  const res = await handle.fastify.inject({
    method: "POST",
    url: "/api/validate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ scope: "workspace" }),
  });
  await handle.fastify.close();
  return res.json() as ValidateResponse;
}

function write(workspaceDir: string, name: string, body: string): void {
  writeFileSync(join(workspaceDir, "workitems", name), body, "utf8");
}

describe("spec §19.3 — local validation failures", () => {
  test("unknown fields are blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "pbi.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  parent:
    adoId: 1
  fields:
    System.Title: x
    Some.Made.Up.Field: 5
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.some((i) => i.code === "unknown_field")).toBe(true);
  });

  test("missing required fields are blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "pbi.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  parent:
    adoId: 1
  fields: {}
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.some((i) => i.code === "missing_required_field")).toBe(true);
  });

  test("invalid enum values are blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "pbi.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  parent:
    adoId: 1
  fields:
    System.Title: x
    Microsoft.VSTS.Common.Priority: 99
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.some((i) => i.code === "invalid_enum_value")).toBe(true);
  });

  test("invalid parent type is blocked (PBI under Epic)", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "tree.yaml",
      `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: e
spec:
  fields:
    System.Title: E
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: p
spec:
  parent:
    localId: e
  fields:
    System.Title: P
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.some((i) => i.code === "invalid_parent_type")).toBe(true);
  });

  test("missing parent for child kinds is blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "feature.yaml",
      `apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: f
spec:
  fields:
    System.Title: F
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.some((i) => i.code === "missing_parent")).toBe(true);
  });

  test("duplicate local aliases are blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "a.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: twin
spec:
  parent:
    adoId: 1
  fields:
    System.Title: A
`,
    );
    write(
      workspaceDir,
      "b.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: twin
spec:
  parent:
    adoId: 1
  fields:
    System.Title: B
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.filter((i) => i.code === "duplicate_local_id").length).toBeGreaterThan(0);
  });

  test("duplicate sibling titles under same parent and kind are blocked (case-insensitive, whitespace-collapsed)", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "tree.yaml",
      `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: e
spec:
  fields:
    System.Title: E
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: f
spec:
  parent:
    localId: e
  fields:
    System.Title: F
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: p1
spec:
  parent:
    localId: f
  fields:
    System.Title: Add latency alert dashboard
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: p2
spec:
  parent:
    localId: f
  fields:
    System.Title: "  Add  Latency Alert  Dashboard  "
`,
    );
    const result = await validate(workspaceDir, templateDir);
    expect(result.issues.filter((i) => i.code === "duplicate_sibling_title").length).toBeGreaterThan(0);
  });
});
