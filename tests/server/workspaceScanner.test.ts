import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, getAllCached, getCached, updateAcceptedBaseline, type DbHandle } from "../../src/server/db.ts";
import { fieldHash, relationHash } from "../../src/server/hash.ts";
import { indexWorkspace, scanWorkspace } from "../../src/server/workspace.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-ws-"));
  tempDirs.push(workspaceDir);
  const templateDir = join(workspaceDir, "templates");
  mkdirSync(templateDir, { recursive: true });
  // Copy our five MVP templates into the workspace's templates dir.
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

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("scanWorkspace", () => {
  test("indexes multiple documents per file with stable indexes", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "trio.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
spec:
  parent:
    localId: feature-x
    adoId: 999
  fields:
    System.Title: A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-b
spec:
  parent:
    localId: feature-x
    adoId: 999
  fields:
    System.Title: B
`,
      "utf8",
    );

    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(scan.documents.length).toBe(2);
    expect(scan.documents[0]?.item?.metadata.localId).toBe("pbi-a");
    expect(scan.documents[0]?.doc.documentIndex).toBe(0);
    expect(scan.documents[1]?.doc.documentIndex).toBe(1);
  });

  test("excludes templates directory from work item scan", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    // No work items, just templates.
    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(scan.documents.length).toBe(0);
    expect(scan.templates.templates.PBI?.workItemType).toBe("PBI");
  });

  test("reports errors when templates are missing", () => {
    const { workspaceDir } = makeWorkspace();
    const scan = scanWorkspace({ workspaceDir, templateDir: "/tmp/nope-xyz" });
    expect(scan.issues.some((i) => i.code === "template_missing")).toBe(true);
  });
});

describe("indexWorkspace", () => {
  test("upserts metadata-only rows; spec.fields content is not stored", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "pbi.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-secret-content
spec:
  parent:
    localId: feature-y
    adoId: 1234
  fields:
    System.Title: SUPER_SECRET_TITLE_DO_NOT_PERSIST
    System.Description: ANOTHER_SECRET_DESCRIPTION
`,
      "utf8",
    );

    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    const scan = scanWorkspace({ workspaceDir, templateDir });
    const result = indexWorkspace(dbHandle.db, scan);
    expect(result.upserted).toBe(1);

    const cached = getAllCached(dbHandle.db);
    expect(cached.length).toBe(1);
    expect(cached[0]?.localId).toBe("pbi-secret-content");
    expect(cached[0]?.parentLocalId).toBe("feature-y");
    expect(cached[0]?.parentAdoId).toBe(1234);

    // CRITICAL: serialize the entire database and confirm field content is absent.
    const dump = dbHandle.db.serialize();
    const text = Buffer.from(dump).toString("utf8");
    expect(text).not.toContain("SUPER_SECRET_TITLE_DO_NOT_PERSIST");
    expect(text).not.toContain("ANOTHER_SECRET_DESCRIPTION");
  });

  test("re-running indexWorkspace updates the existing row, not duplicates", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    const path = join(items, "p.yaml");
    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
spec:
  parent:
    localId: feature-z
    adoId: 555
  fields:
    System.Title: First
`,
      "utf8",
    );

    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }));
    expect(getAllCached(dbHandle.db).length).toBe(1);

    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
spec:
  parent:
    localId: feature-z
    adoId: 555
  fields:
    System.Title: Second
`,
      "utf8",
    );
    indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }));
    expect(getAllCached(dbHandle.db).length).toBe(1);
  });

  test("pruneOrphans removes rows whose local_id no longer appears in the workspace", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    const file1 = join(items, "p1.yaml");
    const file2 = join(items, "p2.yaml");
    writeFileSync(
      file1,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: a
spec:
  fields:
    System.Title: A
`,
      "utf8",
    );
    writeFileSync(
      file2,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: b
spec:
  fields:
    System.Title: B
`,
      "utf8",
    );

    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }));
    expect(getAllCached(dbHandle.db).map((c) => c.localId).sort()).toEqual(["a", "b"]);

    rmSync(file2);
    const result = indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }), {
      pruneOrphans: true,
    });
    expect(result.pruned).toBe(1);
    expect(getAllCached(dbHandle.db).map((c) => c.localId)).toEqual(["a"]);
  });

  test("validation-failed documents do not get indexed", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "broken.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: bad
spec:
  fields: {}
`, // missing System.Title
      "utf8",
    );

    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const scan = scanWorkspace({ workspaceDir, templateDir });
    indexWorkspace(dbHandle.db, scan);

    // The shape is valid (envelope present), so it does get indexed but with
    // sync_status=validation_failed.
    const cached = getAllCached(dbHandle.db);
    expect(cached.length).toBe(1);
    expect(cached[0]?.syncStatus).toBe("validation_failed");
  });

  test("duplicate local IDs are attributed to each duplicate document", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "dupes.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: same-id
spec:
  fields:
    System.Title: A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: same-id
spec:
  fields:
    System.Title: B
`,
      "utf8",
    );

    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(scan.issues.filter((i) => i.code === "duplicate_local_id")).toHaveLength(2);
    expect(scan.documents[0]?.issues.some((i) => i.code === "duplicate_local_id")).toBe(true);
    expect(scan.documents[1]?.issues.some((i) => i.code === "duplicate_local_id")).toBe(true);
  });

  test("indexWorkspace preserves accepted baselines while updating metadata", () => {
    const { workspaceDir, templateDir } = makeWorkspace();
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    const path = join(items, "p.yaml");
    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
  adoId: 100
spec:
  parent:
    adoId: 50
  fields:
    System.Title: First
`,
      "utf8",
    );

    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }));
    const item = parseYamlFile(path)[0]?.content;
    if (!item) throw new Error("fixture did not parse");
    updateAcceptedBaseline(dbHandle.db, {
      localId: "pbi-a",
      adoId: 100,
      rev: 7,
      fieldHash: fieldHash(item),
      relationHash: relationHash(item),
      syncStatus: "synced",
    });

    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-a
  adoId: 100
spec:
  parent:
    adoId: 51
  fields:
    System.Title: Second
`,
      "utf8",
    );
    indexWorkspace(dbHandle.db, scanWorkspace({ workspaceDir, templateDir }));

    const cached = getCached(dbHandle.db, "pbi-a");
    expect(cached?.lastKnownRev).toBe(7);
    expect(cached?.parentAdoId).toBe(51);
    expect(cached?.syncStatus).toBe("local_changed");
  });
});

describe("scanWorkspace — defaults", () => {
  function withDefaults(spec: string): { workspaceDir: string; templateDir: string } {
    const ws = makeWorkspace();
    writeFileSync(join(ws.templateDir, "defaults.yaml"), spec, "utf8");
    return ws;
  }

  test("required field supplied by defaults satisfies workspace validation", () => {
    const { workspaceDir, templateDir } = withDefaults(`apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    PBI:
      fields:
        System.Title: Defaulted
`);
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "pbi.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-1
spec:
  fields: {}
`,
      "utf8",
    );

    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(
      scan.issues.some(
        (i) => i.code === "missing_required_field" && i.field === "spec.fields.System.Title",
      ),
    ).toBe(false);
  });

  test("duplicate sibling title is detected against effective (defaulted) titles", () => {
    const { workspaceDir, templateDir } = withDefaults(`apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    PBI:
      fields:
        System.Title: Same Title
`);
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "two.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-1
spec:
  parent:
    adoId: 100
  fields: {}
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-2
spec:
  parent:
    adoId: 100
  fields: {}
`,
      "utf8",
    );
    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(scan.issues.some((i) => i.code === "duplicate_sibling_title")).toBe(true);
  });

  // Regression: a globally-defined Custom.Product=Platform should satisfy
  // PBI's required-field check even when a sibling kind block has empty/null
  // fields (e.g. user commented out all Feature entries). Previously this
  // caused the entire defaults document to be discarded.
  test("global Custom.Product still satisfies PBI required-field check when a sibling kind has null fields", () => {
    const { workspaceDir, templateDir } = withDefaults(`apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      Custom.Product: Platform
  kinds:
    Feature:
      fields:
`);
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "pbi.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-child-1
spec:
  fields:
    System.Title: child 1
`,
      "utf8",
    );
    const scan = scanWorkspace({ workspaceDir, templateDir });
    const docIssues = scan.documents[0]?.issues ?? [];
    expect(
      docIssues.some(
        (i) =>
          i.code === "missing_required_field" && i.field === "spec.fields.Custom.Product",
      ),
    ).toBe(false);
  });

  test("defaults warnings appear alongside valid workspace scans", () => {
    const { workspaceDir, templateDir } = withDefaults(`apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    NotAKind:
      fields:
        x: y
`);
    const items = join(workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });
    writeFileSync(
      join(items, "pbi.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-1
spec:
  fields:
    System.Title: ok
`,
      "utf8",
    );
    const scan = scanWorkspace({ workspaceDir, templateDir });
    expect(scan.documents.length).toBe(1);
    expect(scan.documents[0]?.item?.metadata.localId).toBe("pbi-1");
    expect(
      scan.issues.some(
        (i) => i.severity === "warning" && i.code === "template_malformed",
      ),
    ).toBe(true);
  });
});
