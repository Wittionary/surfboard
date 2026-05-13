import { describe, expect, test } from "bun:test";
import { howToFix, renderValidationDetails } from "../../src/frontend/render.ts";
import type { ValidationIssue, ValidationIssueCode } from "../../src/shared/types.ts";

describe("howToFix", () => {
  test("returns a non-empty string for every ValidationIssueCode", () => {
    const codes: ValidationIssueCode[] = [
      "missing_required_field",
      "unknown_field",
      "invalid_field_type",
      "invalid_enum_value",
      "invalid_kind",
      "invalid_api_version",
      "yaml_invalid",
      "unknown_top_level_key",
      "tags_not_allowed",
      "missing_parent",
      "invalid_parent_type",
      "missing_parent_ado_id",
      "duplicate_local_id",
      "duplicate_sibling_title",
      "missing_cached_revision",
      "remote_revision_changed",
      "remote_deleted",
      "yaml_changed_during_push",
      "template_missing",
      "template_duplicate",
      "template_malformed",
    ];
    for (const code of codes) {
      const msg = howToFix(code);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("missing_required_field hint mentions required field", () => {
    expect(howToFix("missing_required_field")).toContain("required");
  });

  test("remote_revision_changed hint mentions pull first", () => {
    expect(howToFix("remote_revision_changed")).toContain("Pull");
  });
});

function issue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    severity: "error",
    code: "missing_required_field",
    message: "System.Title is required",
    field: "spec.fields.System.Title",
    yamlPath: "/ws/item.yaml",
    yamlDocumentIndex: 0,
    ...overrides,
  };
}

describe("renderValidationDetails", () => {
  test("returns no-errors message when no error issues", () => {
    const html = renderValidationDetails([issue({ severity: "warning" })]);
    expect(html).toContain("No errors found");
  });

  test("returns no-errors message for empty list", () => {
    const html = renderValidationDetails([]);
    expect(html).toContain("No errors found");
  });

  test("renders one <li> per error issue", () => {
    const html = renderValidationDetails([issue(), issue({ code: "invalid_kind", message: "bad kind" })]);
    const matches = html.match(/<li class="validation-issue">/g);
    expect(matches?.length).toBe(2);
  });

  test("includes line number in loc when present", () => {
    const html = renderValidationDetails([issue({ line: 12 })]);
    expect(html).toContain("Line 12");
  });

  test("includes field in loc when present", () => {
    const html = renderValidationDetails([issue({ field: "spec.fields.System.Title" })]);
    expect(html).toContain("spec.fields.System.Title");
  });

  test("omits loc div when no line or field", () => {
    const html = renderValidationDetails([issue({ field: undefined, line: undefined })]);
    expect(html).not.toContain("validation-issue__loc");
  });

  test("renders fix hint from howToFix", () => {
    const html = renderValidationDetails([issue({ code: "missing_required_field" })]);
    expect(html).toContain("validation-issue__fix");
    expect(html).toContain("→");
  });

  test("escapes special chars in message", () => {
    const html = renderValidationDetails([issue({ message: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("filters out warnings — only errors appear", () => {
    const html = renderValidationDetails([
      issue({ severity: "error", message: "this is an error" }),
      issue({ severity: "warning", message: "this is a warning" }),
    ]);
    expect(html).toContain("this is an error");
    expect(html).not.toContain("this is a warning");
  });
});
