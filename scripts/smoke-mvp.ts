// Final MVP smoke. Boots the local server against a temp workspace populated
// with a small Epic/Feature/PBI tree, drives the local-only flows end-to-end,
// and exercises the pull/push routes with an injected fake AdoClient (no
// live ADO calls). Use the guarded smoke-ado-{read,write} scripts for live
// checks.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../src/server/adoClient.ts";
import { buildAppHandle } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import {
  openDb,
  updateAcceptedBaseline,
} from "../src/server/db.ts";
import { fieldHash, relationHash } from "../src/server/hash.ts";
import { scanWorkspace, indexWorkspace } from "../src/server/workspace.ts";
import { parseYamlFile } from "../src/server/yamlStore.ts";
import type { HealthReport, OperationResult } from "../src/shared/types.ts";

const FIXTURES = resolve(import.meta.dir, "../tests/fixtures/templates");
const ws = mkdtempSync(join(tmpdir(), "surfboard-mvp-smoke-"));
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
    copyFileSync(join(FIXTURES, name), join(templateDir, name));
  }
  const items = join(ws, "workitems");
  mkdirSync(items, { recursive: true });
  writeFileSync(
    join(items, "tree.yaml"),
    `apiVersion: surfboard.ado/v1
kind: Epic
metadata:
  localId: epic-mvp
  adoId: 1
spec:
  fields:
    System.Title: Epic MVP
---
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-mvp
  adoId: 100
spec:
  parent:
    localId: epic-mvp
    adoId: 1
  fields:
    System.Title: Feature MVP
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-mvp
  adoId: 200
spec:
  parent:
    localId: feature-mvp
    adoId: 100
  fields:
    System.Title: PBI MVP
`,
    "utf8",
  );

  const config = loadConfig({
    env: {
      ADO_ORG: "goalliant",
      ADO_PROJECT: "Alliant",
      ADO_PAT: "fake",
      ADO_WORKSPACE_DIR: ws,
      ADO_TEMPLATE_DIR: templateDir,
    },
  });
  const dbHandle = openDb({ workspaceDir: ws });

  // Seed baselines.
  const scan = scanWorkspace({ workspaceDir: ws, templateDir });
  indexWorkspace(dbHandle.db, scan);
  for (const doc of parseYamlFile(join(items, "tree.yaml"))) {
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

  // Fake AdoClient that returns matching revs so push succeeds.
  const fake = new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 }));
      }
      if (u.includes("/wit/wiql")) {
        return Promise.resolve(new Response(JSON.stringify({ workItems: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            count: 3,
            value: [
              { id: 1, rev: 5, fields: { "System.WorkItemType": "Epic", "System.Rev": 5 } },
              { id: 100, rev: 5, fields: { "System.WorkItemType": "Feature", "System.Rev": 5, "System.Parent": 1 } },
              { id: 200, rev: 5, fields: { "System.WorkItemType": "Product Backlog Item", "System.Rev": 5, "System.Parent": 100 } },
            ],
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch,
  });

  const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient: fake });
  const app = handle.fastify;

  const must = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  };

  await must("/api/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as HealthReport;
    if (body.app.version === undefined) throw new Error("missing version");
  });
  await must("/api/workspace/refresh", async () => {
    await app.inject({ method: "POST", url: "/api/workspace/refresh" });
  });
  await must("/api/validate workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/validate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scope: "workspace" }),
    });
    const body = res.json() as { issues: unknown[] };
    if (body.issues.length !== 0) throw new Error(`unexpected issues: ${JSON.stringify(body.issues)}`);
  });
  await must("/api/view/parent/feature-mvp", async () => {
    const res = await app.inject({ method: "GET", url: "/api/view/parent/feature-mvp" });
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  });
  await must("/api/push/all (fixture)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/all",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ parent: { localId: "feature-mvp" }, includeParent: true }),
    });
    const body = res.json() as OperationResult;
    if (body.status !== "success") throw new Error(`status ${body.status}`);
  });
  await must("/api/audit/recent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit/recent" });
    const body = res.json() as { items: unknown[] };
    if (body.items.length === 0) throw new Error("empty audit");
  });

  await app.close();
  dbHandle.close();
  console.log("[smoke-mvp] all checks passed");
} catch (err) {
  console.error("[smoke-mvp] failed:", err);
  exitCode = 1;
} finally {
  rmSync(ws, { recursive: true, force: true });
}
process.exit(exitCode);
