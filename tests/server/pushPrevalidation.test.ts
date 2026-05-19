import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import { pushParentAndChildren } from "../../src/server/syncEngine.ts";
import { scanWorkspace, indexWorkspace } from "../../src/server/workspace.ts";
import { updateAcceptedBaseline } from "../../src/server/db.ts";
import { fieldHash, relationHash } from "../../src/server/hash.ts";

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
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-push-pv-"));
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

function fakeClient(): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((): Promise<Response> =>
      Promise.resolve(new Response("not used in prevalidation", { status: 500 }))) as unknown as typeof fetch,
  });
}

function setupWorkspace(yaml: string): {
  workspaceDir: string;
  dbHandle: DbHandle;
  client: AdoClient;
} {
  const { workspaceDir, templateDir } = makeWorkspace();
  writeFileSync(join(workspaceDir, "workitems", "tree.yaml"), yaml, "utf8");
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir, templateDir });
  indexWorkspace(dbHandle.db, scan);
  return { workspaceDir, dbHandle, client: fakeClient() };
}

describe("push prevalidation — hard blockers", () => {
  test("does not block when child has parent localId but no parent ADO ID; child push proceeds (parent ID is resolved from cached parent)", async () => {
    const { workspaceDir, dbHandle } = setupWorkspace(`
apiVersion: surfboard.ado/v1
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
spec:
  parent:
    localId: feature-a
  fields:
    System.Title: PBI A
`);
    // Fake client that accepts a PATCH so the create path runs to completion.
    const acceptingClient = new AdoClient({
      organization: "goalliant",
      project: "Alliant",
      apiVersion: "7.1",
      pat: "fake",
      fetchImpl: ((_u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.method === "PATCH") {
          return Promise.resolve(
            new Response(JSON.stringify({ id: 999, rev: 1, fields: {} }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const result = await pushParentAndChildren(
      { client: acceptingClient, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(result.status).not.toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "missing_parent_ado_id")).toBe(false);
  });

  test("blocks on missing required field", async () => {
    const { workspaceDir, dbHandle, client } = setupWorkspace(`
apiVersion: surfboard.ado/v1
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
  localId: pbi-bad
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields: {}
`);
    const result = await pushParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(result.status).toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "missing_required_field")).toBe(true);
  });

  test("blocks on duplicate localId across the workspace", async () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    writeFileSync(
      join(workspaceDir, "workitems", "a.yaml"),
      `apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-a
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: F
`,
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "workitems", "b.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: dup
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: dup
spec:
  parent:
    localId: feature-a
    adoId: 100
  fields:
    System.Title: B
`,
      "utf8",
    );
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const scan = scanWorkspace({ workspaceDir, templateDir });
    indexWorkspace(dbHandle.db, scan);

    const result = await pushParentAndChildren(
      { client: fakeClient(), db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(result.status).toBe("blocked");
    expect(result.items.some((i) => i.errorCode === "duplicate_local_id")).toBe(true);
  });

  test("blocks an existing item without a cached revision", async () => {
    const { workspaceDir, dbHandle, client } = setupWorkspace(`
apiVersion: surfboard.ado/v1
kind: Feature
metadata:
  localId: feature-a
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: Feature A
`);
    // The cache row exists from index, but lastKnownRev is undefined because
    // we have not pulled or pushed before. Pushing the parent must block.
    const result = await pushParentAndChildren(
      { client, db: dbHandle.db, workspaceDir },
      { parent: { localId: "feature-a" }, includeParent: true },
    );
    expect(result.status).toBe("blocked");
    expect(
      result.items.some(
        (i) => i.errorCode === "remote_deleted" || i.errorCode === "missing_cached_revision",
      ),
    ).toBe(true);
  });

  test("does not call ADO when prevalidation fails", async () => {
    let calls = 0;
    const client = new AdoClient({
      organization: "goalliant",
      project: "Alliant",
      apiVersion: "7.1",
      pat: "fake",
      fetchImpl: ((): Promise<Response> => {
        calls += 1;
        return Promise.resolve(new Response("nope", { status: 500 }));
      }) as unknown as typeof fetch,
    });
    const ws = setupWorkspaceWithDeps(`
apiVersion: surfboard.ado/v1
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
  localId: pbi-bad
spec:
  parent:
    localId: feature-a
  fields: {}
`);
    await pushParentAndChildren(
      { client, db: ws.dbHandle.db, workspaceDir: ws.workspaceDir },
      { parent: { localId: "feature-a" } },
    );
    expect(calls).toBe(0);
  });
});

// Helper variant that doesn't construct a pre-built client.
function setupWorkspaceWithDeps(yaml: string): {
  workspaceDir: string;
  dbHandle: DbHandle;
} {
  const { workspaceDir, templateDir } = makeWorkspace();
  writeFileSync(join(workspaceDir, "workitems", "tree.yaml"), yaml, "utf8");
  const dbHandle = openDb({ workspaceDir, path: ":memory:" });
  dbHandles.push(dbHandle);
  const scan = scanWorkspace({ workspaceDir, templateDir });
  indexWorkspace(dbHandle.db, scan);
  return { workspaceDir, dbHandle };
}

// Suppress unused import warning for helpers we re-use across companion tests.
void updateAcceptedBaseline;
void fieldHash;
void relationHash;
