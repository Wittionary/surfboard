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
