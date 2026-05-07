import { describe, expect, test } from "bun:test";
import { parseYamlFile } from "../../src/server/yamlStore.ts";
import { canonicalize, canonicalSha256, fieldHash, relationHash } from "../../src/server/hash.ts";
import type { LocalWorkItem } from "../../src/shared/types.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

const tempDirs: string[] = [];

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-hash-"));
  tempDirs.push(dir);
  const path = join(dir, "doc.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("canonicalize", () => {
  test("sorts object keys recursively", () => {
    const a = canonicalize({ b: 1, a: 2, nested: { z: 1, a: 2 } });
    const b = canonicalize({ a: 2, b: 1, nested: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  test("preserves array order", () => {
    const a = canonicalize([3, 1, 2]);
    const b = canonicalize([1, 2, 3]);
    expect(a).not.toBe(b);
  });

  test("treats undefined as null", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe(canonicalize({ a: null, b: null }));
  });
});

describe("fieldHash", () => {
  test("identical fields hash the same regardless of object key order in source YAML", () => {
    const a = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  fields:
    System.Title: Hello
    Microsoft.VSTS.Common.Priority: 2
`,
      ),
    );
    const b = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  fields:
    Microsoft.VSTS.Common.Priority: 2
    System.Title: Hello
`,
      ),
    );
    expect(fieldHash(a)).toBe(fieldHash(b));
  });

  test("comments and blank lines do not change the hash", () => {
    const a = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  fields:
    System.Title: Hello
`,
      ),
    );
    const b = parseFirstDoc(
      tempFile(
        `# Header comment

apiVersion: surfboard.ado/v1
kind: PBI

metadata:
  localId: x
spec:
  # PBI fields
  fields:
    System.Title: Hello

`,
      ),
    );
    expect(fieldHash(a)).toBe(fieldHash(b));
  });

  test("changing a field value changes the hash", () => {
    const a = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  fields:
    System.Title: Hello
`,
      ),
    );
    const b = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  fields:
    System.Title: Goodbye
`,
      ),
    );
    expect(fieldHash(a)).not.toBe(fieldHash(b));
  });

  test("tags hash is order- and duplicate-insensitive", () => {
    const a = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  tags:
    - alpha
    - beta
    - alpha
  fields:
    System.Title: t
`,
      ),
    );
    const b = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  tags:
    - beta
    - alpha
  fields:
    System.Title: t
`,
      ),
    );
    expect(fieldHash(a)).toBe(fieldHash(b));
  });

  test("removing a tag changes the hash", () => {
    const a = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  tags:
    - alpha
    - beta
  fields:
    System.Title: t
`,
      ),
    );
    const b = parseFirstDoc(
      tempFile(
        `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: x
spec:
  tags:
    - alpha
  fields:
    System.Title: t
`,
      ),
    );
    expect(fieldHash(a)).not.toBe(fieldHash(b));
  });
});

describe("relationHash", () => {
  test("identical parent.localId+adoId hash the same", () => {
    const item: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "x" },
      spec: { parent: { localId: "f", adoId: 100 }, fields: { "System.Title": "x" } },
      yamlPath: "/x.yaml",
      yamlDocumentIndex: 0,
    };
    const same: LocalWorkItem = { ...item };
    expect(relationHash(item)).toBe(relationHash(same));
  });

  test("changing parent.adoId changes the relation hash", () => {
    const a: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "x" },
      spec: { parent: { localId: "f", adoId: 100 }, fields: { "System.Title": "x" } },
      yamlPath: "/x.yaml",
      yamlDocumentIndex: 0,
    };
    const b: LocalWorkItem = {
      ...a,
      spec: { parent: { localId: "f", adoId: 200 }, fields: { "System.Title": "x" } },
    };
    expect(relationHash(a)).not.toBe(relationHash(b));
  });

  test("relation hash and field hash are independent — changing one does not change the other", () => {
    const a: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "PBI",
      metadata: { localId: "x" },
      spec: { parent: { adoId: 1 }, fields: { "System.Title": "x" } },
      yamlPath: "/x.yaml",
      yamlDocumentIndex: 0,
    };
    const b: LocalWorkItem = {
      ...a,
      spec: { parent: { adoId: 1 }, fields: { "System.Title": "y" } },
    };
    expect(relationHash(a)).toBe(relationHash(b));
    expect(fieldHash(a)).not.toBe(fieldHash(b));
  });
});

describe("canonicalSha256", () => {
  test("returns 64 hex chars", () => {
    expect(canonicalSha256({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

function parseFirstDoc(path: string): LocalWorkItem {
  const docs = parseYamlFile(path);
  const item = docs[0]?.content;
  if (!item) throw new Error(`fixture did not parse to a work item: ${path}`);
  return item;
}
