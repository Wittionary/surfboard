import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getTemplate, loadTemplates } from "../../src/server/templateStore.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-tpl-"));
  tempDirs.push(dir);
  return dir;
}

function copyTemplates(target: string, names: string[]): void {
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    copyFileSync(join(FIXTURE_TEMPLATES, name), join(target, name));
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("loadTemplates", () => {
  test("loads all five MVP work item templates from fixtures", () => {
    const result = loadTemplates(FIXTURE_TEMPLATES);

    expect(getTemplate(result, "Epic")?.workItemType).toBe("Epic");
    expect(getTemplate(result, "Feature")?.workItemType).toBe("Feature");
    expect(getTemplate(result, "PBI")?.workItemType).toBe("PBI");
    expect(getTemplate(result, "Enabler")?.workItemType).toBe("Enabler");
    expect(getTemplate(result, "Task")?.workItemType).toBe("Task");

    // No template_missing warnings expected when all five templates load.
    expect(result.issues.filter((i) => i.code === "template_missing")).toEqual([]);
  });

  test("captures parent matrix and field rules from each template", () => {
    const result = loadTemplates(FIXTURE_TEMPLATES);
    const task = getTemplate(result, "Task");
    expect(task?.parentTypes).toEqual(["PBI", "Enabler"]);
    const pbi = getTemplate(result, "PBI");
    expect(pbi?.parentTypes).toEqual(["Feature"]);
    expect(pbi?.requiredFields).toContain("System.Title");
    expect(pbi?.fieldRules["Microsoft.VSTS.Common.Priority"]?.allowedValues).toEqual([1, 2, 3, 4]);
    expect(pbi?.tagsAllowed).toBe(true);
    expect(pbi?.unknownFields).toBe("warn");
  });

  test("reports template_missing when a kind has no template", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["epic.schema.yaml", "feature.schema.yaml"]);
    const result = loadTemplates(dir);

    expect(getTemplate(result, "PBI")).toBeUndefined();
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("template_missing");
    const missingMessages = result.issues
      .filter((i) => i.code === "template_missing")
      .map((i) => i.message);
    expect(missingMessages.some((m) => m.includes("PBI"))).toBe(true);
    expect(missingMessages.some((m) => m.includes("Enabler"))).toBe(true);
    expect(missingMessages.some((m) => m.includes("Task"))).toBe(true);
  });

  test("reports template_duplicate when two templates target the same kind", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    // Add a second PBI template with a different filename.
    copyFileSync(
      join(FIXTURE_TEMPLATES, "pbi.schema.yaml"),
      join(dir, "pbi.schema.duplicate.yaml"),
    );
    const result = loadTemplates(dir);

    expect(result.issues.some((i) => i.code === "template_duplicate")).toBe(true);
  });

  test("reports template_malformed for invalid template YAML", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "broken.schema.yaml"),
      "apiVersion: surfboard.ado/v1\nkind: WorkItemTemplate\nspec:\n  workItemType: Banana\n",
      "utf8",
    );
    const result = loadTemplates(dir);

    expect(result.issues.some((i) => i.code === "template_malformed")).toBe(true);
  });

  test("reports a directory-level error when template directory is missing", () => {
    const dir = makeTempDir();
    const missing = join(dir, "does-not-exist");
    const result = loadTemplates(missing);

    expect(Object.keys(result.templates).length).toBe(0);
    expect(result.issues.some((i) => i.code === "template_missing")).toBe(true);
  });

  test("ignores files that are not WorkItemTemplate documents", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "not-a-template.yaml"),
      "apiVersion: surfboard.ado/v1\nkind: PBI\nmetadata:\n  localId: x\nspec:\n  fields:\n    System.Title: x\n",
      "utf8",
    );
    copyTemplates(dir, ["pbi.schema.yaml"]);
    const result = loadTemplates(dir);

    expect(getTemplate(result, "PBI")?.workItemType).toBe("PBI");
    // Non-template document should produce a malformed issue (kind is PBI not WorkItemTemplate).
    expect(result.issues.some((i) => i.code === "template_malformed")).toBe(true);
  });

  test("source records the file path and document index of the template", () => {
    const result = loadTemplates(FIXTURE_TEMPLATES);
    const epic = getTemplate(result, "Epic");
    expect(epic?.source.path.endsWith("epic.schema.yaml")).toBe(true);
    expect(epic?.source.documentIndex).toBe(0);
  });
});

// Sanity check that all expected files exist in the fixture directory.
test("fixture template directory has the five MVP files", () => {
  const names = readdirSync(FIXTURE_TEMPLATES).sort();
  expect(names).toEqual([
    "enabler.schema.yaml",
    "epic.schema.yaml",
    "feature.schema.yaml",
    "pbi.schema.yaml",
    "task.schema.yaml",
  ]);
});

describe("loadTemplates — WorkItemDefaults dispatch", () => {
  test("loads a WorkItemDefaults document and exposes it on the result", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
metadata:
  name: workspace-defaults
spec:
  global:
    fields:
      System.AreaPath: Alliant
  kinds:
    PBI:
      fields:
        Custom.Product: MyProduct
`,
      "utf8",
    );

    const result = loadTemplates(dir);

    expect(result.defaults?.global?.fields).toEqual({ "System.AreaPath": "Alliant" });
    expect(result.defaults?.kinds?.PBI?.fields).toEqual({ "Custom.Product": "MyProduct" });
    expect(getTemplate(result, "PBI")?.workItemType).toBe("PBI");
    // Defaults file presence must not produce a template_malformed error.
    expect(result.issues.some((i) => i.code === "template_malformed" && i.severity === "error")).toBe(false);
  });

  test("recognizes any YAML filename for a defaults document", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "workitem-defaults.yml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: TeamA
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(result.defaults?.global?.fields).toEqual({ "System.AreaPath": "TeamA" });
  });

  test("malformed defaults document produces a warning, not an error", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  kinds:
    NotAKind:
      fields:
        x: y
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    const defaultsIssues = result.issues.filter(
      (i) => i.code === "template_malformed" && i.yamlPath?.endsWith("defaults.yaml"),
    );
    expect(defaultsIssues.length).toBeGreaterThan(0);
    expect(defaultsIssues.every((i) => i.severity === "warning")).toBe(true);
    // Templates still load.
    expect(getTemplate(result, "PBI")?.workItemType).toBe("PBI");
  });

  test("multi-document defaults file warns and uses doc 0", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: First
---
apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: Second
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(result.defaults?.global?.fields).toEqual({ "System.AreaPath": "First" });
    expect(
      result.issues.some(
        (i) =>
          i.severity === "warning" &&
          i.code === "template_malformed" &&
          i.message.includes("multiple YAML documents"),
      ),
    ).toBe(true);
  });

  test("multiple defaults documents across files: first by scan order wins, rest warn", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "a-defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: A
`,
      "utf8",
    );
    writeFileSync(
      join(dir, "b-defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      System.AreaPath: B
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    // scanWorkspaceFiles sorts by full path, so "a-defaults" comes first.
    expect(result.defaults?.global?.fields).toEqual({ "System.AreaPath": "A" });
    expect(
      result.issues.some(
        (i) =>
          i.severity === "warning" &&
          i.code === "template_malformed" &&
          i.message.includes("Duplicate WorkItemDefaults"),
      ),
    ).toBe(true);
  });

  test("unknown template-directory document kinds warn but do not block template loading", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "extra.yaml"),
      `apiVersion: surfboard.ado/v1
kind: SomethingElse
spec: {}
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(getTemplate(result, "PBI")?.workItemType).toBe("PBI");
    const extraIssues = result.issues.filter((i) => i.yamlPath?.endsWith("extra.yaml"));
    expect(extraIssues.length).toBeGreaterThan(0);
    expect(extraIssues.every((i) => i.severity === "warning")).toBe(true);
  });

  // Regression: a kind block whose `fields:` parses to null (e.g. because all
  // entries are commented out) used to fail with "must be a mapping" and
  // discard the entire defaults document, including unrelated global
  // defaults. Now it must be treated as "no entries" and the rest of the
  // defaults document must still load.
  test("kind scope with null fields/metadata/tags is tolerated and does not drop other defaults", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      Custom.Product: Platform
  kinds:
    Feature:
      fields:
    PBI:
      metadata:
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(result.defaults?.global?.fields?.["Custom.Product"]).toBe("Platform");
    // No spurious "must be a mapping" warnings for empty sections.
    const malformed = result.issues.filter(
      (i) => i.code === "template_malformed" && i.message.includes("must be a mapping"),
    );
    expect(malformed).toEqual([]);
  });

  // Regression: a malformed kind block previously caused the whole defaults
  // document to be discarded. Now it must warn for that one kind and keep
  // the rest of the document loaded.
  test("one malformed kind warns but other kinds and global still load", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
      Custom.Product: Platform
  kinds:
    Feature:
      fields: [not, a, mapping]
    PBI:
      fields:
        Microsoft.VSTS.Common.Priority: 2
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(result.defaults?.global?.fields?.["Custom.Product"]).toBe("Platform");
    expect(result.defaults?.kinds?.PBI?.fields?.["Microsoft.VSTS.Common.Priority"]).toBe(2);
    expect(result.defaults?.kinds?.Feature).toBeUndefined();
    expect(
      result.issues.some(
        (i) =>
          i.severity === "warning" &&
          i.code === "template_malformed" &&
          i.message.includes("spec.kinds.Feature"),
      ),
    ).toBe(true);
  });

  // Regression: an empty `fields:` at the global level must not drop global
  // defaults either (mirrors the kind-scope case above).
  test("global scope with null fields is tolerated", () => {
    const dir = makeTempDir();
    copyTemplates(dir, ["pbi.schema.yaml"]);
    writeFileSync(
      join(dir, "defaults.yaml"),
      `apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
spec:
  global:
    fields:
  kinds:
    PBI:
      fields:
        Custom.Product: Platform
`,
      "utf8",
    );
    const result = loadTemplates(dir);
    expect(result.defaults?.kinds?.PBI?.fields?.["Custom.Product"]).toBe("Platform");
    expect(
      result.issues.some(
        (i) => i.code === "template_malformed" && i.message.includes("spec.global.fields"),
      ),
    ).toBe(false);
  });
});
