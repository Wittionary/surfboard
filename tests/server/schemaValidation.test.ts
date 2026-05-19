import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadTemplates, type WorkItemDefaults } from "../../src/server/templateStore.ts";
import { validateDocument } from "../../src/server/validator.ts";
import type { ParsedDocument } from "../../src/server/yamlStore.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");
const templates = loadTemplates(FIXTURE_TEMPLATES);

function doc(raw: unknown, path = "/tmp/example.yaml", documentIndex = 0): ParsedDocument {
  return { path, documentIndex, raw };
}

describe("validateDocument — envelope", () => {
  test("accepts a valid PBI work item", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "pbi-1" },
        spec: {
          parent: { localId: "feature-1", adoId: 100 },
          fields: { "System.Title": "Hello" },
        },
      }),
      { templates },
    );
    expect(issues).toEqual([]);
  });

  test("flags unknown top-level keys", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: { fields: { "System.Title": "x" } },
        weird: true,
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "unknown_top_level_key" && i.field === "weird")).toBe(true);
  });

  test("flags invalid apiVersion", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "v999",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: { fields: { "System.Title": "x" } },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_api_version")).toBe(true);
  });

  test("flags invalid kind and short-circuits remaining checks", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "Banana",
        metadata: { localId: "x" },
        spec: { fields: {} },
      }),
      { templates },
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe("invalid_kind");
  });

  test("flags missing metadata.localId", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: {},
        spec: { fields: { "System.Title": "x" } },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "missing_required_field" && i.field === "metadata.localId")).toBe(true);
  });

  test("flags non-positive adoId", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x", adoId: -5 },
        spec: { fields: { "System.Title": "x" } },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_field_type" && i.field === "metadata.adoId")).toBe(true);
  });

  test("flags unknown metadata keys", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x", surprise: true },
        spec: { fields: { "System.Title": "x" } },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "unknown_field" && i.field === "metadata.surprise")).toBe(true);
  });
});

describe("validateDocument — fields and templates", () => {
  test("flags missing required field", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: { fields: {} },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "missing_required_field" && i.field === "spec.fields.System.Title")).toBe(true);
  });

  test("flags unknown field when template policy is fail", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          fields: {
            "System.Title": "x",
            "Some.MadeUp.Field": 1,
          },
        },
      }),
      { templates },
    );
    expect(
      issues.some((i) => i.code === "unknown_field" && i.field === "spec.fields.Some.MadeUp.Field"),
    ).toBe(true);
  });

  test("flags invalid enum value via fieldRules.allowedValues", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          fields: {
            "System.Title": "x",
            "Microsoft.VSTS.Common.Priority": 9,
          },
        },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_enum_value")).toBe(true);
  });

  test("flags invalid field type via fieldRules.type", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          fields: {
            "System.Title": "x",
            "Microsoft.VSTS.Common.Priority": "not-a-number",
          },
        },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_field_type")).toBe(true);
  });

  test("permits enum values listed in template", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          fields: {
            "System.Title": "x",
            "Microsoft.VSTS.Common.Priority": 2,
            "System.State": "Approved",
          },
        },
      }),
      { templates },
    );
    expect(issues).toEqual([]);
  });

  test("allows tags when template tags.allowed=true", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          tags: ["alpha", "beta"],
          fields: { "System.Title": "x" },
        },
      }),
      { templates },
    );
    expect(issues).toEqual([]);
  });

  test("flags non-string tags entries", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          tags: ["ok", 5 as unknown as string],
          fields: { "System.Title": "x" },
        },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_field_type" && i.field === "spec.tags")).toBe(true);
  });

  test("issues carry yamlPath and yamlDocumentIndex", () => {
    const issues = validateDocument(
      doc(
        {
          apiVersion: "surfboard.ado/v1",
          kind: "PBI",
          metadata: { localId: "x" },
          spec: { fields: {} },
        },
        "/tmp/some.yaml",
        2,
      ),
      { templates },
    );
    expect(issues[0]?.yamlPath).toBe("/tmp/some.yaml");
    expect(issues[0]?.yamlDocumentIndex).toBe(2);
  });
});

describe("validateDocument — defaults", () => {
  const defaults: WorkItemDefaults = {
    global: { fields: { "System.AreaPath": "Alliant" } },
    kinds: {
      PBI: {
        fields: { "System.Title": "Defaulted Title", "Microsoft.VSTS.Common.Priority": 2 },
      },
    },
    source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
  };

  test("required field supplied by defaults satisfies validation", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "pbi-1" },
        spec: { fields: {} },
      }),
      { templates, defaults },
    );
    expect(issues).toEqual([]);
  });

  test("still flags missing required field when neither YAML nor defaults supply it", () => {
    const noTitleDefaults: WorkItemDefaults = {
      global: { fields: { "System.AreaPath": "Alliant" } },
      source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
    };
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "pbi-1" },
        spec: { fields: {} },
      }),
      { templates, defaults: noTitleDefaults },
    );
    expect(
      issues.some(
        (i) => i.code === "missing_required_field" && i.field === "spec.fields.System.Title",
      ),
    ).toBe(true);
  });

  test("defaulted field with invalid enum value is reported against the work item", () => {
    const badDefaults: WorkItemDefaults = {
      kinds: {
        PBI: { fields: { "Microsoft.VSTS.Common.Priority": 9 } },
      },
      source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
    };
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "pbi-1" },
        spec: { fields: { "System.Title": "x" } },
      }),
      { templates, defaults: badDefaults },
    );
    expect(issues.some((i) => i.code === "invalid_enum_value")).toBe(true);
  });

  test("authored value overrides defaulted invalid value", () => {
    const badDefaults: WorkItemDefaults = {
      kinds: {
        PBI: { fields: { "Microsoft.VSTS.Common.Priority": 9 } },
      },
      source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
    };
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "pbi-1" },
        spec: {
          fields: { "System.Title": "x", "Microsoft.VSTS.Common.Priority": 2 },
        },
      }),
      { templates, defaults: badDefaults },
    );
    expect(issues.some((i) => i.code === "invalid_enum_value")).toBe(false);
  });
});

describe("validateDocument — parent envelope", () => {
  test("flags unknown spec.parent keys", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          parent: { localId: "f", adoId: 1, weird: true },
          fields: { "System.Title": "x" },
        },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "unknown_field" && i.field === "spec.parent.weird")).toBe(true);
  });

  test("flags non-positive parent.adoId", () => {
    const issues = validateDocument(
      doc({
        apiVersion: "surfboard.ado/v1",
        kind: "PBI",
        metadata: { localId: "x" },
        spec: {
          parent: { adoId: 0 },
          fields: { "System.Title": "x" },
        },
      }),
      { templates },
    );
    expect(issues.some((i) => i.code === "invalid_field_type" && i.field === "spec.parent.adoId")).toBe(true);
  });
});
