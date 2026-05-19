import { describe, expect, test } from "bun:test";
import {
  buildLocalViewModel,
  renderChildRows,
  renderFooter,
  renderParentHero,
  validationLabel,
} from "../../src/frontend/render.ts";
import type { ParentViewResponse, WorkItemView } from "../../src/shared/api.ts";

function child(over: Partial<WorkItemView>): WorkItemView {
  return {
    localId: "c",
    workItemType: "PBI",
    title: "C",
    state: "New",
    yamlPath: "/c.yaml",
    yamlDocumentIndex: 0,
    validationIssues: [],
    ...over,
  };
}

const parentResponse = (over: Partial<ParentViewResponse> = {}): ParentViewResponse => ({
  parent: {
    localId: "feature-x",
    adoId: 100,
    workItemType: "Feature",
    title: "Feature X",
    state: "Approved",
    yamlPath: "/f.yaml",
    yamlDocumentIndex: 0,
    validationIssues: [],
  },
  children: [],
  ...over,
});

describe("renderParentHero", () => {
  test("renders all parent fields", () => {
    const view = parentResponse().parent;
    const hero = renderParentHero(view);
    expect(hero.type).toBe("Feature");
    expect(hero.title).toBe("Feature X");
    expect(hero.adoId).toBe("100");
    expect(hero.state).toBe("Approved");
    expect(hero.syncStatus).toBe("synced");
    expect(hero.yamlPath).toBe("/f.yaml");
  });

  test("returns placeholder when no parent", () => {
    const hero = renderParentHero(null);
    expect(hero.title).toBe("No parent selected");
    expect(hero.adoId).toBe("—");
  });

  test("local-only sync status when adoId is missing", () => {
    const hero = renderParentHero(parentResponse({
      parent: {
        ...parentResponse().parent,
        adoId: undefined,
      },
    }).parent);
    expect(hero.syncStatus).toBe("local_only");
  });

  test("validation_failed sync status when validation errors present", () => {
    const hero = renderParentHero(parentResponse({
      parent: {
        ...parentResponse().parent,
        validationIssues: [
          { severity: "error", code: "missing_required_field", message: "x" },
        ],
      },
    }).parent);
    expect(hero.syncStatus).toBe("validation_failed");
  });
});

describe("renderChildRows", () => {
  test("renders placeholder row when no children", () => {
    expect(renderChildRows([])).toContain("No children loaded");
  });

  test("renders one row per child with status pill, type, title, and ids", () => {
    const html = renderChildRows([
      child({ localId: "p1", title: "First", adoId: 1, state: "New" }),
      child({ localId: "p2", title: "Second" }),
    ]);
    expect(html).toContain("data-local-id=\"p1\"");
    expect(html).toContain("data-local-id=\"p2\"");
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain("status-pill--ok");
  });

  test("renders error pill for child with validation errors", () => {
    const html = renderChildRows([
      child({
        localId: "bad",
        validationIssues: [
          { severity: "error", code: "missing_required_field", message: "title required" },
        ],
      }),
    ]);
    expect(html).toContain("status-pill--fail");
    expect(html).toContain("title required");
  });

  test("renders warn pill for child with only warnings", () => {
    const html = renderChildRows([
      child({
        localId: "warn",
        validationIssues: [
          { severity: "warning", code: "unknown_field", message: "extra" },
        ],
      }),
    ]);
    expect(html).toContain("status-pill--warn");
  });

  test("escapes HTML in titles to prevent injection", () => {
    const html = renderChildRows([
      child({ title: "<img src=x onerror=alert(1)>" }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderFooter", () => {
  test("renders refresh time, health, and version", () => {
    const footer = renderFooter(
      {
        workspaceDir: "/ws",
        templateDir: "/ws/templates",
        refreshedAt: new Date("2026-05-07T10:00:00Z").toISOString(),
        documentCount: 4,
        validItemCount: 4,
        issueCounts: {},
      },
      "ok",
    );
    expect(footer.lastSync).toContain("Refreshed:");
    expect(footer.lastSync).toContain("4 docs");
    expect(footer.health).toContain("ok");
    expect(footer.version).toContain("0.1.0");
  });

  test("placeholders when status missing", () => {
    const footer = renderFooter(null, null);
    expect(footer.lastSync).toContain("never");
    expect(footer.health).toContain("—");
  });
});

describe("validationLabel", () => {
  test("returns ok when no issues", () => {
    expect(validationLabel([])).toEqual({ text: "Valid", severity: "ok" });
  });

  test("counts errors first", () => {
    const out = validationLabel([
      { severity: "warning", code: "unknown_field", message: "x" },
      { severity: "error", code: "missing_required_field", message: "y" },
      { severity: "error", code: "missing_required_field", message: "z" },
    ]);
    expect(out).toEqual({ text: "2 errors", severity: "fail" });
  });

  test("warnings only", () => {
    const out = validationLabel([
      { severity: "warning", code: "unknown_field", message: "x" },
    ]);
    expect(out).toEqual({ text: "1 warn", severity: "warn" });
  });
});

describe("buildLocalViewModel", () => {
  test("returns empty model when no parent response", () => {
    const m = buildLocalViewModel(null);
    expect(m.parent).toBeNull();
    expect(m.children).toEqual([]);
  });

  test("returns parent and children from response", () => {
    const m = buildLocalViewModel(parentResponse({
      children: [child({ localId: "p1" }), child({ localId: "p2" })],
    }));
    expect(m.parent?.localId).toBe("feature-x");
    expect(m.children.map((c) => c.localId)).toEqual(["p1", "p2"]);
  });
});
