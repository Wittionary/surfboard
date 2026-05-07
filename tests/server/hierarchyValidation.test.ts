import { describe, expect, test } from "bun:test";
import { validateWorkspace } from "../../src/server/validator.ts";
import type { LocalWorkItem, WorkItemType } from "../../src/shared/types.ts";

function item(
  kind: WorkItemType,
  localId: string,
  spec: LocalWorkItem["spec"] = { fields: { "System.Title": localId } },
  options: { adoId?: number; yamlPath?: string; documentIndex?: number } = {},
): LocalWorkItem {
  return {
    apiVersion: "surfboard.ado/v1",
    kind,
    metadata: { localId, ...(options.adoId !== undefined ? { adoId: options.adoId } : {}) },
    spec,
    yamlPath: options.yamlPath ?? `/tmp/${localId}.yaml`,
    yamlDocumentIndex: options.documentIndex ?? 0,
  };
}

describe("validateWorkspace — parent matrix", () => {
  test("flags Feature without parent", () => {
    const issues = validateWorkspace([item("Feature", "f")]).issues;
    expect(issues.some((i) => i.code === "missing_parent" && i.localId === "f")).toBe(true);
  });

  test("flags Epic with parent declared", () => {
    const issues = validateWorkspace([
      item("Epic", "e", {
        parent: { localId: "x" },
        fields: { "System.Title": "Epic" },
      }),
    ]).issues;
    expect(issues.some((i) => i.code === "invalid_parent_type" && i.localId === "e")).toBe(true);
  });

  test("flags PBI with Epic as parent (PBI requires Feature)", () => {
    const issues = validateWorkspace([
      item("Epic", "e1"),
      item("PBI", "p1", {
        parent: { localId: "e1" },
        fields: { "System.Title": "P" },
      }),
    ]).issues;
    expect(issues.some((i) => i.code === "invalid_parent_type" && i.localId === "p1")).toBe(true);
  });

  test("permits Task under PBI and Task under Enabler", () => {
    const issues = validateWorkspace([
      item("Epic", "e"),
      item("Feature", "f", { parent: { localId: "e" }, fields: { "System.Title": "F" } }),
      item("PBI", "p", { parent: { localId: "f" }, fields: { "System.Title": "P" } }),
      item("Enabler", "n", { parent: { localId: "f" }, fields: { "System.Title": "N" } }),
      item("Task", "t1", { parent: { localId: "p" }, fields: { "System.Title": "T1" } }),
      item("Task", "t2", { parent: { localId: "n" }, fields: { "System.Title": "T2" } }),
    ]).issues;
    expect(issues).toEqual([]);
  });

  test("flags Feature whose parent is missing both localId and adoId", () => {
    const issues = validateWorkspace([
      item("Feature", "f", {
        parent: {},
        fields: { "System.Title": "F" },
      }),
    ]).issues;
    expect(issues.some((i) => i.code === "missing_parent" && i.localId === "f")).toBe(true);
  });

  test("permits parent referenced only by adoId (remote-only parent)", () => {
    const issues = validateWorkspace([
      item("PBI", "p", {
        parent: { adoId: 100 },
        fields: { "System.Title": "P" },
      }),
    ]).issues;
    expect(issues).toEqual([]);
  });

  test("flags PBI whose parent localId does not resolve and has no adoId", () => {
    const issues = validateWorkspace([
      item("PBI", "p", {
        parent: { localId: "ghost-feature" },
        fields: { "System.Title": "P" },
      }),
    ]).issues;
    expect(issues.some((i) => i.code === "missing_parent" && i.localId === "p")).toBe(true);
  });
});

describe("validateWorkspace — duplicates", () => {
  test("flags duplicate localId across files", () => {
    const issues = validateWorkspace([
      item("PBI", "twin", { parent: { adoId: 1 }, fields: { "System.Title": "A" } }, { yamlPath: "/a.yaml" }),
      item("PBI", "twin", { parent: { adoId: 1 }, fields: { "System.Title": "B" } }, { yamlPath: "/b.yaml" }),
    ]).issues;
    const dups = issues.filter((i) => i.code === "duplicate_local_id");
    expect(dups.length).toBe(2);
    const paths = dups.map((i) => i.yamlPath).sort();
    expect(paths).toEqual(["/a.yaml", "/b.yaml"]);
  });

  test("flags normalized duplicate sibling titles by parent and kind", () => {
    const issues = validateWorkspace([
      item("Epic", "e"),
      item("Feature", "f", { parent: { localId: "e" }, fields: { "System.Title": "F" } }),
      item("PBI", "a", {
        parent: { localId: "f" },
        fields: { "System.Title": "Add latency alert dashboard" },
      }),
      item("PBI", "b", {
        parent: { localId: "f" },
        fields: { "System.Title": "  add  latency  ALERT dashboard  " },
      }),
    ]).issues;
    expect(issues.some((i) => i.code === "duplicate_sibling_title" && i.localId === "a")).toBe(true);
    expect(issues.some((i) => i.code === "duplicate_sibling_title" && i.localId === "b")).toBe(true);
  });

  test("does not flag identical titles when parents differ", () => {
    const issues = validateWorkspace([
      item("Epic", "e"),
      item("Feature", "f1", { parent: { localId: "e" }, fields: { "System.Title": "F1" } }),
      item("Feature", "f2", { parent: { localId: "e" }, fields: { "System.Title": "F2" } }),
      item("PBI", "a", { parent: { localId: "f1" }, fields: { "System.Title": "Same Title" } }),
      item("PBI", "b", { parent: { localId: "f2" }, fields: { "System.Title": "Same Title" } }),
    ]).issues;
    expect(issues.some((i) => i.code === "duplicate_sibling_title")).toBe(false);
  });

  test("does not flag identical titles when child kinds differ under same parent", () => {
    const issues = validateWorkspace([
      item("Epic", "e"),
      item("Feature", "f", { parent: { localId: "e" }, fields: { "System.Title": "F" } }),
      item("PBI", "p", { parent: { localId: "f" }, fields: { "System.Title": "Same" } }),
      item("Enabler", "n", { parent: { localId: "f" }, fields: { "System.Title": "Same" } }),
    ]).issues;
    expect(issues.some((i) => i.code === "duplicate_sibling_title")).toBe(false);
  });

  test("groups by adoId when localId differs but parent.adoId is the same", () => {
    const issues = validateWorkspace([
      item("PBI", "p1", { parent: { adoId: 999 }, fields: { "System.Title": "Title" } }),
      item("PBI", "p2", { parent: { adoId: 999 }, fields: { "System.Title": "title" } }),
    ]).issues;
    expect(issues.some((i) => i.code === "duplicate_sibling_title")).toBe(true);
  });
});
