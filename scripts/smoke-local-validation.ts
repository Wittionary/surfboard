// Boots the app against a temp workspace, drops a small valid+invalid set of
// YAML files, and walks the local API to confirm refresh, validate, and
// parent view behave end-to-end.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAppHandle } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { openDb } from "../src/server/db.ts";
import type { ParentViewResponse, ValidateResponse, WorkspaceStatusResponse } from "../src/shared/api.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../tests/fixtures/templates");

const ws = mkdtempSync(join(tmpdir(), "surfboard-phase2-smoke-"));
let exitCode = 0;
try {
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
  const items = join(ws, "workitems");
  mkdirSync(items, { recursive: true });
  writeFileSync(
    join(items, "tree.yaml"),
    `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: epic-platform
  adoId: 200000
spec:
  fields:
    System.Title: Platform reliability
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-obs
  adoId: 200001
spec:
  parent:
    localId: epic-platform
    adoId: 200000
  fields:
    System.Title: Observability refresh
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-dashboard
spec:
  parent:
    localId: feature-obs
    adoId: 200001
  fields:
    System.Title: Add latency alert dashboard
    Microsoft.VSTS.Common.Priority: 2
`,
    "utf8",
  );

  const config = loadConfig({
    env: { ADO_WORKSPACE_DIR: ws, ADO_TEMPLATE_DIR: templateDir },
  });
  const dbHandle = openDb({ workspaceDir: ws });
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null });

  const refresh = await handle.fastify.inject({
    method: "POST",
    url: "/api/workspace/refresh",
  });
  const refreshBody = refresh.json() as WorkspaceStatusResponse;
  if (refreshBody.documentCount !== 3) {
    throw new Error(`expected 3 docs, got ${refreshBody.documentCount}`);
  }

  const validate = await handle.fastify.inject({
    method: "POST",
    url: "/api/validate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ scope: "workspace" }),
  });
  const validateBody = validate.json() as ValidateResponse;
  const errors = validateBody.issues.filter((i) => i.severity === "error");
  if (errors.length !== 0) {
    throw new Error(`expected 0 validation errors, got ${errors.length}: ${JSON.stringify(errors)}`);
  }

  const view = await handle.fastify.inject({
    method: "GET",
    url: "/api/view/parent/feature-obs",
  });
  const viewBody = view.json() as ParentViewResponse;
  if (viewBody.parent.localId !== "feature-obs") {
    throw new Error(`expected feature-obs, got ${viewBody.parent.localId}`);
  }
  if (viewBody.children.length !== 1 || viewBody.children[0]?.localId !== "pbi-dashboard") {
    throw new Error(`expected 1 child pbi-dashboard, got ${JSON.stringify(viewBody.children)}`);
  }

  console.log(
    `[smoke-local-validation] ok — docs=${refreshBody.documentCount} valid=${refreshBody.validItemCount} children=${viewBody.children.length}`,
  );

  await handle.fastify.close();
  dbHandle.close();
} catch (err) {
  console.error("[smoke-local-validation] failed:", err);
  exitCode = 1;
} finally {
  rmSync(ws, { recursive: true, force: true });
}
process.exit(exitCode);
