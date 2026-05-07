import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendDocument,
  parseYamlFile,
  readDocument,
  scanWorkspaceFiles,
  writeDocument,
} from "../../src/server/yamlStore.ts";
import type { LocalWorkItem } from "../../src/shared/types.ts";

const FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/yaml/multi-doc.yaml");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-yaml-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("parseYamlFile (multi-document)", () => {
  test("parses three documents from multi-doc fixture with stable indexes", () => {
    const docs = parseYamlFile(FIXTURE_PATH);
    expect(docs.length).toBe(3);
    expect(docs[0]?.documentIndex).toBe(0);
    expect(docs[1]?.documentIndex).toBe(1);
    expect(docs[2]?.documentIndex).toBe(2);
    expect(docs[0]?.content?.kind).toBe("Feature");
    expect(docs[1]?.content?.kind).toBe("PBI");
    expect(docs[2]?.content?.kind).toBe("PBI");
  });

  test("populates yamlPath and yamlDocumentIndex on parsed content", () => {
    const docs = parseYamlFile(FIXTURE_PATH);
    expect(docs[1]?.content?.yamlPath).toBe(FIXTURE_PATH);
    expect(docs[1]?.content?.yamlDocumentIndex).toBe(1);
  });

  test("returns parseError for malformed documents without crashing siblings", () => {
    const dir = makeTempDir();
    const path = join(dir, "broken.yaml");
    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: ok
spec:
  fields:
    System.Title: ok
---
not: [valid: yaml`,
      "utf8",
    );
    const docs = parseYamlFile(path);
    expect(docs.length).toBe(2);
    expect(docs[0]?.parseError).toBeUndefined();
    expect(docs[1]?.parseError).toBeDefined();
  });

  test("rejects non-work-item shaped documents but keeps them visible", () => {
    const dir = makeTempDir();
    const path = join(dir, "weird.yaml");
    writeFileSync(path, "just: a string", "utf8");
    const docs = parseYamlFile(path);
    expect(docs[0]?.content).toBeUndefined();
    expect(docs[0]?.raw).toEqual({ just: "a string" });
  });
});

describe("readDocument", () => {
  test("reads a specific document by index", () => {
    const doc = readDocument(FIXTURE_PATH, 2);
    expect(doc?.content?.metadata.localId).toBe("pbi-multi-doc-second");
  });

  test("returns null for out-of-range index", () => {
    expect(readDocument(FIXTURE_PATH, 99)).toBeNull();
  });
});

describe("writeDocument", () => {
  test("updates one document and preserves siblings' content", () => {
    const dir = makeTempDir();
    const path = join(dir, "trio.yaml");
    writeFileSync(
      path,
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: a
spec:
  fields:
    System.Title: A
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: b
spec:
  fields:
    System.Title: B original
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: c
spec:
  fields:
    System.Title: C
`,
      "utf8",
    );

    const updated: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "b" },
      spec: { fields: { "System.Title": "B updated" } },
      yamlPath: path,
      yamlDocumentIndex: 1,
    };
    writeDocument(path, 1, updated);

    const after = parseYamlFile(path);
    expect(after.length).toBe(3);
    expect(after[0]?.content?.metadata.localId).toBe("a");
    expect(after[0]?.content?.spec.fields["System.Title"]).toBe("A");
    expect(after[1]?.content?.spec.fields["System.Title"]).toBe("B updated");
    expect(after[2]?.content?.spec.fields["System.Title"]).toBe("C");
  });

  test("creates a new document at the end when index equals current length", () => {
    const dir = makeTempDir();
    const path = join(dir, "grow.yaml");
    writeFileSync(
      path,
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

    const newDoc: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "b" },
      spec: { fields: { "System.Title": "B" } },
      yamlPath: path,
      yamlDocumentIndex: 1,
    };
    writeDocument(path, 1, newDoc);

    const after = parseYamlFile(path);
    expect(after.length).toBe(2);
    expect(after[1]?.content?.metadata.localId).toBe("b");
  });

  test("throws when index is beyond end of file", () => {
    const dir = makeTempDir();
    const path = join(dir, "small.yaml");
    writeFileSync(
      path,
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
    const item: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "z" },
      spec: { fields: { "System.Title": "Z" } },
      yamlPath: path,
      yamlDocumentIndex: 5,
    };
    expect(() => writeDocument(path, 5, item)).toThrow();
  });
});

describe("appendDocument", () => {
  test("creates the file when absent and returns index 0", () => {
    const dir = makeTempDir();
    const path = join(dir, "subdir", "new.yaml");
    const item: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "fresh" },
      spec: { fields: { "System.Title": "Fresh" } },
      yamlPath: path,
      yamlDocumentIndex: 0,
    };
    const idx = appendDocument(path, item);
    expect(idx).toBe(0);

    const docs = parseYamlFile(path);
    expect(docs.length).toBe(1);
    expect(docs[0]?.content?.metadata.localId).toBe("fresh");
  });
});

describe("scanWorkspaceFiles", () => {
  test("returns YAML files recursively with document counts", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "a.yaml"),
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
    const sub = join(dir, "nested");
    mkdtempInside(sub);
    writeFileSync(
      join(sub, "b.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: b1
spec:
  fields:
    System.Title: B1
---
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: b2
spec:
  fields:
    System.Title: B2
`,
      "utf8",
    );

    const files = scanWorkspaceFiles(dir);
    expect(files.length).toBe(2);
    const a = files.find((f) => f.path.endsWith("a.yaml"));
    const b = files.find((f) => f.path.endsWith("b.yaml"));
    expect(a?.documentCount).toBe(1);
    expect(b?.documentCount).toBe(2);
  });

  test("excludes the configured excludeDir subtree", () => {
    const dir = makeTempDir();
    const templates = join(dir, "templates");
    mkdtempInside(templates);
    writeFileSync(
      join(templates, "pbi.schema.yaml"),
      "apiVersion: surfboard.ado/v1\nkind: WorkItemTemplate\nmetadata:\n  name: pbi\nspec:\n  workItemType: PBI\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "real.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: r
spec:
  fields:
    System.Title: R
`,
      "utf8",
    );
    const files = scanWorkspaceFiles(dir, { excludeDir: templates });
    expect(files.length).toBe(1);
    expect(files[0]?.path.endsWith("real.yaml")).toBe(true);
  });
});

function mkdtempInside(target: string): void {
  // tiny helper used only in tests; the real workspace creation handles this
  // through the scanner's lazy directory walk.
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(target, { recursive: true });
}
