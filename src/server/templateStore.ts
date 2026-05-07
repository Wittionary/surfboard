// Template store per spec §6. Loads `WorkItemTemplate` documents from the
// configured template directory and exposes lookup by work item kind.

import { existsSync } from "node:fs";
import { parseYamlFile, scanWorkspaceFiles } from "./yamlStore.ts";
import { WORK_ITEM_TYPES } from "../shared/constants.ts";
import type { ValidationIssue, WorkItemType } from "../shared/types.ts";

export type TemplateFieldType = "string" | "integer" | "number" | "boolean";
export type UnknownFieldsPolicy = "fail" | "warn" | "allow";

export type TemplateFieldRule = {
  type?: TemplateFieldType;
  allowedValues?: ReadonlyArray<string | number | boolean>;
};

export type WorkItemTemplate = {
  workItemType: WorkItemType;
  parentTypes: readonly WorkItemType[];
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  fieldRules: Record<string, TemplateFieldRule>;
  tagsAllowed: boolean;
  unknownFields: UnknownFieldsPolicy;
  source: { path: string; documentIndex: number };
};

export type TemplateLoadResult = {
  templates: Partial<Record<WorkItemType, WorkItemTemplate>>;
  issues: ValidationIssue[];
};

const VALID_FIELD_TYPES: ReadonlySet<TemplateFieldType> = new Set([
  "string",
  "integer",
  "number",
  "boolean",
]);

const VALID_UNKNOWN_FIELDS: ReadonlySet<UnknownFieldsPolicy> = new Set(["fail", "warn", "allow"]);

export function loadTemplates(templateDir: string): TemplateLoadResult {
  const templates: Partial<Record<WorkItemType, WorkItemTemplate>> = {};
  const issues: ValidationIssue[] = [];

  if (!templateDir || !existsSync(templateDir)) {
    issues.push({
      severity: "error",
      code: "template_missing",
      message: `Template directory not found: ${templateDir || "(unset)"}`,
    });
    return { templates, issues };
  }

  const files = scanWorkspaceFiles(templateDir);
  for (const file of files) {
    const docs = parseYamlFile(file.path);
    for (const doc of docs) {
      const result = parseTemplateDocument(file.path, doc.documentIndex, doc.raw);
      if (result.issue) {
        issues.push(result.issue);
        continue;
      }
      const tpl = result.template;
      if (!tpl) continue;
      const existing = templates[tpl.workItemType];
      if (existing) {
        issues.push({
          severity: "error",
          code: "template_duplicate",
          message: `Duplicate template for ${tpl.workItemType} at ${tpl.source.path}#${tpl.source.documentIndex} (also at ${existing.source.path}#${existing.source.documentIndex})`,
          yamlPath: tpl.source.path,
          yamlDocumentIndex: tpl.source.documentIndex,
        });
        continue;
      }
      templates[tpl.workItemType] = tpl;
    }
  }

  for (const kind of WORK_ITEM_TYPES) {
    if (!templates[kind]) {
      issues.push({
        severity: "warning",
        code: "template_missing",
        message: `No template found for work item type ${kind}`,
      });
    }
  }

  return { templates, issues };
}

export function getTemplate(
  loadResult: TemplateLoadResult,
  kind: WorkItemType,
): WorkItemTemplate | undefined {
  return loadResult.templates[kind];
}

function parseTemplateDocument(
  path: string,
  documentIndex: number,
  raw: unknown,
): { template?: WorkItemTemplate; issue?: ValidationIssue } {
  if (raw === null || raw === undefined) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: "Template document is empty",
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  if (typeof raw !== "object") {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: "Template document must be a mapping",
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.apiVersion !== "surfboard.ado/v1") {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: "Template apiVersion must be surfboard.ado/v1",
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  if (obj.kind !== "WorkItemTemplate") {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: "Template kind must be WorkItemTemplate",
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }

  const spec = obj.spec;
  if (typeof spec !== "object" || spec === null) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: "Template spec must be a mapping",
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  const specObj = spec as Record<string, unknown>;

  const workItemType = specObj.workItemType;
  if (typeof workItemType !== "string" || !WORK_ITEM_TYPES.includes(workItemType as WorkItemType)) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: `Template spec.workItemType must be one of ${WORK_ITEM_TYPES.join(", ")}`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }

  const parentTypes = readStringArray(specObj.parentTypes, "spec.parentTypes", path, documentIndex);
  if ("issue" in parentTypes) return parentTypes;

  for (const pt of parentTypes.value) {
    if (!WORK_ITEM_TYPES.includes(pt as WorkItemType)) {
      return {
        issue: {
          severity: "error",
          code: "template_malformed",
          message: `Template parentType ${pt} is not a known work item type`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
  }

  const requiredFields = readStringArray(
    specObj.requiredFields,
    "spec.requiredFields",
    path,
    documentIndex,
  );
  if ("issue" in requiredFields) return requiredFields;

  const optionalFields = readStringArray(
    specObj.optionalFields,
    "spec.optionalFields",
    path,
    documentIndex,
    /* allowMissing */ true,
  );
  if ("issue" in optionalFields) return optionalFields;

  const fieldRulesRaw = specObj.fieldRules;
  const fieldRules: Record<string, TemplateFieldRule> = {};
  if (fieldRulesRaw !== undefined) {
    if (typeof fieldRulesRaw !== "object" || fieldRulesRaw === null) {
      return {
        issue: {
          severity: "error",
          code: "template_malformed",
          message: "spec.fieldRules must be a mapping",
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    for (const [name, rawRule] of Object.entries(fieldRulesRaw as Record<string, unknown>)) {
      const ruleResult = parseFieldRule(name, rawRule, path, documentIndex);
      if ("issue" in ruleResult) return ruleResult;
      fieldRules[name] = ruleResult.value;
    }
  }

  const tagsAllowed = readTagsAllowed(specObj.tags);
  const unknownFields = readUnknownFields(specObj.unknownFields, path, documentIndex);
  if ("issue" in unknownFields) return unknownFields;

  return {
    template: {
      workItemType: workItemType as WorkItemType,
      parentTypes: parentTypes.value as WorkItemType[],
      requiredFields: requiredFields.value,
      optionalFields: optionalFields.value,
      fieldRules,
      tagsAllowed,
      unknownFields: unknownFields.value,
      source: { path, documentIndex },
    },
  };
}

function readStringArray(
  value: unknown,
  field: string,
  path: string,
  documentIndex: number,
  allowMissing = false,
): { value: string[] } | { issue: ValidationIssue } {
  if (value === undefined || value === null) {
    if (allowMissing) return { value: [] };
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: `Template ${field} is required`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  if (!Array.isArray(value)) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: `Template ${field} must be an array of strings`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return {
        issue: {
          severity: "error",
          code: "template_malformed",
          message: `Template ${field} entries must be strings`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    out.push(entry);
  }
  return { value: out };
}

function parseFieldRule(
  name: string,
  raw: unknown,
  path: string,
  documentIndex: number,
): { value: TemplateFieldRule } | { issue: ValidationIssue } {
  if (typeof raw !== "object" || raw === null) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: `Template fieldRules.${name} must be a mapping`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  const obj = raw as Record<string, unknown>;
  const rule: TemplateFieldRule = {};
  if (obj.type !== undefined) {
    if (typeof obj.type !== "string" || !VALID_FIELD_TYPES.has(obj.type as TemplateFieldType)) {
      return {
        issue: {
          severity: "error",
          code: "template_malformed",
          message: `Template fieldRules.${name}.type must be one of ${[...VALID_FIELD_TYPES].join(", ")}`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    rule.type = obj.type as TemplateFieldType;
  }
  if (obj.allowedValues !== undefined) {
    if (!Array.isArray(obj.allowedValues)) {
      return {
        issue: {
          severity: "error",
          code: "template_malformed",
          message: `Template fieldRules.${name}.allowedValues must be an array`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    rule.allowedValues = obj.allowedValues as ReadonlyArray<string | number | boolean>;
  }
  return { value: rule };
}

function readTagsAllowed(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.allowed === true;
}

function readUnknownFields(
  value: unknown,
  path: string,
  documentIndex: number,
): { value: UnknownFieldsPolicy } | { issue: ValidationIssue } {
  if (value === undefined) return { value: "fail" };
  if (typeof value !== "string" || !VALID_UNKNOWN_FIELDS.has(value as UnknownFieldsPolicy)) {
    return {
      issue: {
        severity: "error",
        code: "template_malformed",
        message: `Template spec.unknownFields must be one of ${[...VALID_UNKNOWN_FIELDS].join(", ")}`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  return { value: value as UnknownFieldsPolicy };
}
