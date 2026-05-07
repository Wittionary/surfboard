// Schema validation per spec §6 and §7. Validates a single parsed YAML document
// against the work item envelope and the kind's template. Hierarchy and
// duplicate validation live in their own pass (Task 2.5).

import type { ParsedDocument } from "./yamlStore.ts";
import type { TemplateLoadResult, WorkItemTemplate, TemplateFieldRule, TemplateFieldType } from "./templateStore.ts";
import { getTemplate } from "./templateStore.ts";
import { API_VERSION, WORK_ITEM_TYPES } from "../shared/constants.ts";
import type { ValidationIssue, WorkItemType } from "../shared/types.ts";

export type ValidationContext = {
  templates: TemplateLoadResult;
};

const ALLOWED_TOP_LEVEL = new Set(["apiVersion", "kind", "metadata", "spec"]);
const ALLOWED_METADATA = new Set(["localId", "adoId"]);
const ALLOWED_SPEC = new Set(["parent", "tags", "fields"]);
const ALLOWED_PARENT = new Set(["localId", "adoId"]);

export function validateDocument(
  doc: ParsedDocument,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const here = (extra: Partial<ValidationIssue>): Partial<ValidationIssue> => ({
    yamlPath: doc.path,
    yamlDocumentIndex: doc.documentIndex,
    ...extra,
  });

  if (doc.parseError) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: doc.parseError,
      ...here({}),
    });
    return issues;
  }

  if (doc.raw === undefined || doc.raw === null) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "Document is empty",
      ...here({}),
    });
    return issues;
  }

  if (typeof doc.raw !== "object" || Array.isArray(doc.raw)) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "Work item document must be a mapping",
      ...here({}),
    });
    return issues;
  }

  const obj = doc.raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      issues.push({
        severity: "error",
        code: "unknown_top_level_key",
        message: `Unknown top-level key: ${key}`,
        field: key,
        ...here({}),
      });
    }
  }

  if (obj.apiVersion !== API_VERSION) {
    issues.push({
      severity: "error",
      code: "invalid_api_version",
      message: `apiVersion must be ${API_VERSION}`,
      field: "apiVersion",
      ...here({}),
    });
  }

  const kind = obj.kind;
  if (typeof kind !== "string" || !WORK_ITEM_TYPES.includes(kind as WorkItemType)) {
    issues.push({
      severity: "error",
      code: "invalid_kind",
      message: `kind must be one of ${WORK_ITEM_TYPES.join(", ")}`,
      field: "kind",
      ...here({}),
    });
    return issues; // Without a valid kind, downstream checks aren't meaningful.
  }

  const localId = validateMetadata(obj.metadata, issues, here);

  const spec = obj.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "spec must be a mapping",
      field: "spec",
      ...here({ localId }),
    });
    return issues;
  }
  const specObj = spec as Record<string, unknown>;

  for (const key of Object.keys(specObj)) {
    if (!ALLOWED_SPEC.has(key)) {
      issues.push({
        severity: "error",
        code: "unknown_field",
        message: `Unknown spec key: ${key}`,
        field: `spec.${key}`,
        ...here({ localId }),
      });
    }
  }

  validateParent(specObj.parent, issues, here, localId);

  const template = getTemplate(ctx.templates, kind as WorkItemType);
  validateFields(kind as WorkItemType, specObj.fields, specObj.tags, template, issues, here, localId);

  return issues;
}

function validateMetadata(
  raw: unknown,
  issues: ValidationIssue[],
  here: (e: Partial<ValidationIssue>) => Partial<ValidationIssue>,
): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "metadata must be a mapping with localId",
      field: "metadata",
      ...here({}),
    });
    return undefined;
  }
  const meta = raw as Record<string, unknown>;
  for (const key of Object.keys(meta)) {
    if (!ALLOWED_METADATA.has(key)) {
      issues.push({
        severity: "error",
        code: "unknown_field",
        message: `Unknown metadata key: ${key}`,
        field: `metadata.${key}`,
        ...here({}),
      });
    }
  }

  let localId: string | undefined;
  if (typeof meta.localId !== "string" || meta.localId.trim().length === 0) {
    issues.push({
      severity: "error",
      code: "missing_required_field",
      message: "metadata.localId is required and must be a non-empty string",
      field: "metadata.localId",
      ...here({}),
    });
  } else {
    localId = meta.localId;
  }

  if (meta.adoId !== undefined) {
    if (typeof meta.adoId !== "number" || !Number.isInteger(meta.adoId) || meta.adoId <= 0) {
      issues.push({
        severity: "error",
        code: "invalid_field_type",
        message: "metadata.adoId must be a positive integer when present",
        field: "metadata.adoId",
        ...here({ localId }),
      });
    }
  }

  return localId;
}

function validateParent(
  raw: unknown,
  issues: ValidationIssue[],
  here: (e: Partial<ValidationIssue>) => Partial<ValidationIssue>,
  localId: string | undefined,
): void {
  if (raw === undefined) return;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "spec.parent must be a mapping",
      field: "spec.parent",
      ...here({ localId }),
    });
    return;
  }
  const parent = raw as Record<string, unknown>;
  for (const key of Object.keys(parent)) {
    if (!ALLOWED_PARENT.has(key)) {
      issues.push({
        severity: "error",
        code: "unknown_field",
        message: `Unknown spec.parent key: ${key}`,
        field: `spec.parent.${key}`,
        ...here({ localId }),
      });
    }
  }
  if (parent.localId !== undefined && typeof parent.localId !== "string") {
    issues.push({
      severity: "error",
      code: "invalid_field_type",
      message: "spec.parent.localId must be a string",
      field: "spec.parent.localId",
      ...here({ localId }),
    });
  }
  if (parent.adoId !== undefined) {
    if (
      typeof parent.adoId !== "number" ||
      !Number.isInteger(parent.adoId) ||
      parent.adoId <= 0
    ) {
      issues.push({
        severity: "error",
        code: "invalid_field_type",
        message: "spec.parent.adoId must be a positive integer",
        field: "spec.parent.adoId",
        ...here({ localId }),
      });
    }
  }
}

function validateFields(
  kind: WorkItemType,
  rawFields: unknown,
  rawTags: unknown,
  template: WorkItemTemplate | undefined,
  issues: ValidationIssue[],
  here: (e: Partial<ValidationIssue>) => Partial<ValidationIssue>,
  localId: string | undefined,
): void {
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    issues.push({
      severity: "error",
      code: "yaml_invalid",
      message: "spec.fields must be a mapping",
      field: "spec.fields",
      ...here({ localId }),
    });
    return;
  }
  const fields = rawFields as Record<string, unknown>;

  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags) || !rawTags.every((t) => typeof t === "string")) {
      issues.push({
        severity: "error",
        code: "invalid_field_type",
        message: "spec.tags must be an array of strings",
        field: "spec.tags",
        ...here({ localId }),
      });
    }
    if (template && !template.tagsAllowed && Array.isArray(rawTags) && rawTags.length > 0) {
      issues.push({
        severity: "error",
        code: "tags_not_allowed",
        message: `Tags are not allowed for ${kind} per template`,
        field: "spec.tags",
        ...here({ localId }),
      });
    }
  }

  if (!template) return; // template_missing reported elsewhere

  const requiredSet = new Set(template.requiredFields);
  const optionalSet = new Set(template.optionalFields);
  const knownFieldSet = new Set([...requiredSet, ...optionalSet, ...Object.keys(template.fieldRules)]);

  for (const required of requiredSet) {
    const value = fields[required];
    if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
      issues.push({
        severity: "error",
        code: "missing_required_field",
        message: `Required field missing or empty: ${required}`,
        field: `spec.fields.${required}`,
        ...here({ localId }),
      });
    }
  }

  for (const fieldName of Object.keys(fields)) {
    if (!knownFieldSet.has(fieldName)) {
      const policy = template.unknownFields;
      if (policy === "fail") {
        issues.push({
          severity: "error",
          code: "unknown_field",
          message: `Unknown field for ${kind}: ${fieldName}`,
          field: `spec.fields.${fieldName}`,
          ...here({ localId }),
        });
      } else if (policy === "warn") {
        issues.push({
          severity: "warning",
          code: "unknown_field",
          message: `Unknown field for ${kind}: ${fieldName}`,
          field: `spec.fields.${fieldName}`,
          ...here({ localId }),
        });
      }
    }
    const rule = template.fieldRules[fieldName];
    if (rule) {
      validateFieldRule(fieldName, fields[fieldName], rule, issues, here, localId);
    }
  }
}

function validateFieldRule(
  fieldName: string,
  value: unknown,
  rule: TemplateFieldRule,
  issues: ValidationIssue[],
  here: (e: Partial<ValidationIssue>) => Partial<ValidationIssue>,
  localId: string | undefined,
): void {
  if (value === undefined) return;
  if (rule.type && !matchesType(value, rule.type)) {
    issues.push({
      severity: "error",
      code: "invalid_field_type",
      message: `Field ${fieldName} must be of type ${rule.type}`,
      field: `spec.fields.${fieldName}`,
      ...here({ localId }),
    });
    return;
  }
  if (rule.allowedValues && rule.allowedValues.length > 0) {
    const ok = rule.allowedValues.some((allowed) => allowed === value);
    if (!ok) {
      issues.push({
        severity: "error",
        code: "invalid_enum_value",
        message: `Field ${fieldName}=${JSON.stringify(value)} not in allowed values`,
        field: `spec.fields.${fieldName}`,
        ...here({ localId }),
      });
    }
  }
}

function matchesType(value: unknown, type: TemplateFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}
