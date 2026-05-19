// The live workspace/templates schemas reflect the Alliant ADO process
// customization: fields that ADO blocks a push on AND has no server-side
// default for must appear in requiredFields, so the validator surfaces them
// locally instead of letting ADO fail the push with a cryptic message.
//
// Pulled from the live `wit/workitemtypes/<type>/fields` discovery against the
// Alliant project (2026-05). Re-run scripts/smoke-ado-read.ts to refresh.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import type { ValidateResponse } from "../../src/server/routes.ts";

const WORKSPACE_TEMPLATES = resolve(import.meta.dir, "../../workspace/templates");
const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-wstpl-"));
  tempDirs.push(workspaceDir);
  const templateDir = join(workspaceDir, "templates");
  mkdirSync(templateDir, { recursive: true });
  for (const name of readdirSync(WORKSPACE_TEMPLATES)) {
    if (!name.endsWith(".schema.yaml")) continue;
    copyFileSync(join(WORKSPACE_TEMPLATES, name), join(templateDir, name));
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

describe("workspace/templates — Alliant process customization", () => {
  test("PBI missing Custom.Product is blocked with missing_required_field", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "pbi.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-missing-product
spec:
  parent:
    adoId: 1
  fields:
    System.Title: PBI without product
`,
    );
    const result = await validate(workspaceDir, templateDir);
    const issue = result.issues.find(
      (i) => i.code === "missing_required_field" && i.field === "spec.fields.Custom.Product",
    );
    expect(issue).toBeDefined();
  });

  test("PBI matching the smoke payload (Title + Custom.Product) validates clean", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "pbi.yaml",
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-smoke-shape
spec:
  parent:
    adoId: 1
  fields:
    System.Title: Surfboard smoke PBI
    System.Description: Created by smoke-style payload.
    Custom.Product: Other
`,
    );
    const result = await validate(workspaceDir, templateDir);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  test("Enabler missing System.Description and Custom.EnablerType is blocked", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "enabler.yaml",
      `apiVersion: surfboard.ado/v1
kind: Enabler
metadata:
  localId: enabler-bare
spec:
  parent:
    adoId: 1
  fields:
    System.Title: Bare enabler
`,
    );
    const result = await validate(workspaceDir, templateDir);
    const missing = result.issues
      .filter((i) => i.code === "missing_required_field")
      .map((i) => i.field);
    expect(missing).toContain("spec.fields.System.Description");
    expect(missing).toContain("spec.fields.Custom.EnablerType");
  });

  test("Enabler with invalid Custom.EnablerType is blocked with invalid_enum_value", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    write(
      workspaceDir,
      "enabler.yaml",
      `apiVersion: surfboard.ado/v1
kind: Enabler
metadata:
  localId: enabler-bad-type
spec:
  parent:
    adoId: 1
  fields:
    System.Title: Bad enabler type
    System.Description: Has a description.
    Custom.EnablerType: Not A Real Type
`,
    );
    const result = await validate(workspaceDir, templateDir);
    const bad = result.issues.find(
      (i) => i.code === "invalid_enum_value" && i.field === "spec.fields.Custom.EnablerType",
    );
    expect(bad).toBeDefined();
  });

  test("Epic and Feature still only require System.Title (ADO provides defaults for the rest)", async () => {
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
    System.Title: Minimal epic
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: f
spec:
  parent:
    localId: e
  fields:
    System.Title: Minimal feature
`,
    );
    const result = await validate(workspaceDir, templateDir);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});
