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

function setup(yaml: string, baselineRev = 5): { workspaceDir: string; dbHandle: DbHandle } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-update-"));
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
      rev: baselineRev,
      fieldHash: fieldHash(item),
      relationHash: relationHash(item),
      syncStatus: "synced",
    });
  }
  return { workspaceDir, dbHandle };
}

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      Promise.resolve(handler(String(url), init))) as typeof fetch,
  });
}

const REMOTE_FEATURE = {
  id: 100,
  rev: 5,
  fields: {
    "System.WorkItemType": "Feature",
    "System.Title": "Feature A",
    "System.Rev": 5,
    "System.Parent": 50,
  },
};
const REMOTE_PBI = {
  id: 200,
  rev: 5,
  fields: {
    "System.WorkItemType": "Product Backlog Item",
    "System.Title": "PBI A",
    "System.Rev": 5,
    "System.Parent": 100,
  },
};

const STANDARD_YAML = `apiVersion: surfboard.ado/v1
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
    System.Title: PBI A updated
`;

describe("push update — existing items", () => {
  test("every update patch starts with a /rev test op equal to cached rev", async () => {
    const { workspaceDir, dbHandle } = setup(STANDARD_YAML);
    const patchBodies: unknown[][] = [];
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ id: url.includes("/100") ? 100 : 200, rev: 6, fields: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ count: 2, value: [REMOTE_FEATURE, REMOTE_PBI] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("success");
    expect(result.summary.updated).toBe(2);
    expect(result.summary.created).toBe(0);
    expect(result.summary.pulled).toBe(0);
    expect(patchBodies.length).toBe(2);
    for (const body of patchBodies) {
      expect(body[0]).toEqual({ op: "test", path: "/rev", value: 5 });
    }
  });

  test("updates baseline only after ADO success", async () => {
    const { workspaceDir, dbHandle } = setup(STANDARD_YAML);
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        // Simulate failure for the PBI patch only.
        if (url.includes("/200")) {
          return new Response("conflict", { status: 409, statusText: "Conflict" });
        }
        return new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ count: 2, value: [REMOTE_FEATURE, REMOTE_PBI] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("partial_failure");
    // Parent was updated successfully, baseline now rev 6.
    const featureCache = getCachedByAdoId(dbHandle.db, 100);
    expect(featureCache?.lastKnownRev).toBe(6);
    // PBI failed; baseline stays at 5.
    const pbiCache = getCachedByAdoId(dbHandle.db, 200);
    expect(pbiCache?.lastKnownRev).toBe(5);
  });

  test("ADO 4xx surfaces as failed result, not blocked", async () => {
    const { workspaceDir, dbHandle } = setup(STANDARD_YAML);
    const c = client((url, init) => {
      if (init?.method === "PATCH") {
        return new Response("bad request", { status: 400, statusText: "Bad Request" });
      }
      return new Response(
        JSON.stringify({ count: 2, value: [REMOTE_FEATURE, REMOTE_PBI] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("partial_failure");
    expect(result.items.some((i) => i.status === "failed")).toBe(true);
  });

  // Regression: when a user deletes a field from authored YAML, the update
  // patch must still carry the defaulted value to ADO. Otherwise the user
  // has no way to "let the default take over" — deleting from YAML would
  // simply omit the field from the patch and ADO would keep its old value.
  test("update patch carries defaulted values for fields the user deleted from YAML", async () => {
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
  localId: pbi-x
  adoId: 200
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: child 1
`;
    const { workspaceDir, dbHandle } = setup(yaml);
    // Drop a defaults.yaml beside the templates AFTER setup has captured
    // baselines, then re-baseline using effective hashes so the push path
    // doesn't trip on local_changed.
    writeFileSync(
      join(workspaceDir, "templates", "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: Alliant\\Shared Services\\SRE
      System.IterationPath: Alliant\\SRE\\26Q2
      Custom.Product: Platform
`,
      "utf8",
    );
    // Rebase the PBI's accepted baseline using effective fields.
    const { applyDefaults } = await import("../../src/server/defaults.ts");
    const { loadTemplates } = await import("../../src/server/templateStore.ts");
    const defaults = loadTemplates(join(workspaceDir, "templates")).defaults;
    const pbi = parseYamlFile(join(workspaceDir, "workitems", "tree.yaml"))
      .find((d) => d.content?.metadata.localId === "pbi-x")?.content;
    if (!pbi) throw new Error("pbi-x fixture missing");
    updateAcceptedBaseline(dbHandle.db, {
      localId: "pbi-x",
      adoId: 200,
      rev: 5,
      fieldHash: fieldHash(applyDefaults(pbi, defaults)),
      relationHash: relationHash(applyDefaults(pbi, defaults)),
      syncStatus: "synced",
    });

    let pbiPatchBody: Array<{ op: string; path: string; value?: unknown }> = [];
    const c = client((url, init) => {
      if (init?.method === "PATCH" && url.includes("/200")) {
        pbiPatchBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: 200, rev: 6, fields: {} }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ count: 2, value: [REMOTE_FEATURE, REMOTE_PBI] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir, templateDir: join(workspaceDir, "templates") },
      { parent: { localId: "feature-a" }, childLocalIds: ["pbi-x"] },
    );
    expect(result.status).toBe("success");
    const areaPath = pbiPatchBody.find((o) => o.path === "/fields/System.AreaPath");
    const iter = pbiPatchBody.find((o) => o.path === "/fields/System.IterationPath");
    const product = pbiPatchBody.find((o) => o.path === "/fields/Custom.Product");
    expect(areaPath?.value).toBe("Alliant\\Shared Services\\SRE");
    expect(iter?.value).toBe("Alliant\\SRE\\26Q2");
    expect(product?.value).toBe("Platform");
  });

  // Regression: when ADO_TEMPLATE_DIR is set to a non-conventional path
  // (i.e. NOT <workspaceDir>/templates), the engine must still load defaults
  // when the route passes templateDir through deps explicitly.
  test("engine honors explicit templateDir from deps instead of guessing workspaceDir/templates", async () => {
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
  localId: pbi-x
  adoId: 200
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: child 1
`;
    const { workspaceDir, dbHandle } = setup(yaml);
    // Put templates in a sibling directory, NOT in workspaceDir/templates.
    const externalTemplateDir = mkdtempSync(join(tmpdir(), "surfboard-ext-tpl-"));
    tempDirs.push(externalTemplateDir);
    for (const name of [
      "epic.schema.yaml",
      "feature.schema.yaml",
      "pbi.schema.yaml",
      "enabler.schema.yaml",
      "task.schema.yaml",
    ]) {
      copyFileSync(join(FIXTURE_TEMPLATES, name), join(externalTemplateDir, name));
    }
    writeFileSync(
      join(externalTemplateDir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      Custom.Product: Platform
`,
      "utf8",
    );
    // Rebase baseline using effective hashes from the external defaults.
    const { applyDefaults } = await import("../../src/server/defaults.ts");
    const { loadTemplates } = await import("../../src/server/templateStore.ts");
    const defaults = loadTemplates(externalTemplateDir).defaults;
    expect(defaults).toBeDefined();
    const pbi = parseYamlFile(join(workspaceDir, "workitems", "tree.yaml"))
      .find((d) => d.content?.metadata.localId === "pbi-x")?.content;
    if (!pbi) throw new Error("pbi-x fixture missing");
    updateAcceptedBaseline(dbHandle.db, {
      localId: "pbi-x",
      adoId: 200,
      rev: 5,
      fieldHash: fieldHash(applyDefaults(pbi, defaults)),
      relationHash: relationHash(applyDefaults(pbi, defaults)),
      syncStatus: "synced",
    });

    let pbiPatchBody: Array<{ op: string; path: string; value?: unknown }> = [];
    const c = client((url, init) => {
      if (init?.method === "PATCH" && url.includes("/200")) {
        pbiPatchBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: 200, rev: 6, fields: {} }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: 100, rev: 6, fields: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ count: 2, value: [REMOTE_FEATURE, REMOTE_PBI] }),
        { status: 200 },
      );
    });
    const result = await pushParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir, templateDir: externalTemplateDir },
      { parent: { localId: "feature-a" }, childLocalIds: ["pbi-x"] },
    );
    expect(result.status).toBe("success");
    const product = pbiPatchBody.find((o) => o.path === "/fields/Custom.Product");
    expect(product?.value).toBe("Platform");
  });
});
