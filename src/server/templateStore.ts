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

export type WorkItemDefaultsScope = {
  metadata?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  tags?: readonly string[];
};

export type WorkItemDefaults = {
  global?: WorkItemDefaultsScope;
  kinds?: Partial<Record<WorkItemType, WorkItemDefaultsScope>>;
  source: { path: string; documentIndex: number };
};

export type TemplateLoadResult = {
  templates: Partial<Record<WorkItemType, WorkItemTemplate>>;
  defaults?: WorkItemDefaults;
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
  let defaults: WorkItemDefaults | undefined;

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
    const fileHasDefaults = docs.some((d) => looksLikeDefaultsDoc(d.raw));
    // A YAML parse error wipes out `raw`, which would otherwise make a
    // defaults file look like an empty template. Detect the parse error here
    // and surface it directly so the user sees the YAML message, not a
    // misleading "Template document is empty".
    const fileLooksLikeDefaultsByName = /(^|[/\\])defaults?\.(yaml|yml)$/i.test(file.path);
    if (
      (fileHasDefaults || fileLooksLikeDefaultsByName) &&
      docs.some((d) => d.parseError)
    ) {
      const errDoc = docs.find((d) => d.parseError);
      issues.push({
        severity: "warning",
        code: "template_malformed",
        message: `WorkItemDefaults file ${file.path} failed to parse: ${errDoc?.parseError}`,
        yamlPath: file.path,
        yamlDocumentIndex: errDoc?.documentIndex ?? 0,
      });
      continue;
    }
    if (fileHasDefaults && docs.length > 1) {
      issues.push({
        severity: "warning",
        code: "template_malformed",
        message: `WorkItemDefaults file ${file.path} contains multiple YAML documents; only document 0 is used`,
        yamlPath: file.path,
        yamlDocumentIndex: 0,
      });
    }
    for (const doc of docs) {
      const kind = getDocumentKind(doc.raw);
      if (kind === "WorkItemDefaults") {
        if (doc.documentIndex > 0) continue;
        const result = parseDefaultsDocument(file.path, doc.documentIndex, doc.raw);
        issues.push(...result.issues);
        if (!result.defaults) continue;
        if (defaults) {
          issues.push({
            severity: "warning",
            code: "template_malformed",
            message: `Duplicate WorkItemDefaults at ${result.defaults.source.path}#${result.defaults.source.documentIndex}; using ${defaults.source.path}#${defaults.source.documentIndex}`,
            yamlPath: result.defaults.source.path,
            yamlDocumentIndex: result.defaults.source.documentIndex,
          });
          continue;
        }
        defaults = result.defaults;
        continue;
      }
      // If file is dedicated to defaults, skip parsing remaining docs as templates.
      if (fileHasDefaults) continue;
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

  return { templates, defaults, issues };
}

function getDocumentKind(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object") return undefined;
  const k = (raw as Record<string, unknown>).kind;
  return typeof k === "string" ? k : undefined;
}

function looksLikeDefaultsDoc(raw: unknown): boolean {
  return getDocumentKind(raw) === "WorkItemDefaults";
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
        severity: "warning",
        code: "template_malformed",
        message: `Template directory document at ${path}#${documentIndex} has unknown kind ${JSON.stringify(obj.kind)}; expected WorkItemTemplate or WorkItemDefaults`,
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

function parseDefaultsDocument(
  path: string,
  documentIndex: number,
  raw: unknown,
): { defaults?: WorkItemDefaults; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const here = (msg: string): ValidationIssue => ({
    severity: "warning",
    code: "template_malformed",
    message: msg,
    yamlPath: path,
    yamlDocumentIndex: documentIndex,
  });

  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { issues: [here("WorkItemDefaults document must be a mapping")] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.apiVersion !== "surfboard.ado/v1") {
    return { issues: [here("WorkItemDefaults apiVersion must be surfboard.ado/v1")] };
  }
  const spec = obj.spec;
  if (spec === undefined || spec === null) {
    return { defaults: { source: { path, documentIndex } }, issues };
  }
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return { issues: [here("WorkItemDefaults spec must be a mapping")] };
  }
  const specObj = spec as Record<string, unknown>;
  const global = parseDefaultsScope(specObj.global, path, documentIndex, "spec.global");
  if ("issue" in global) issues.push(global.issue);

  const kinds: Partial<Record<WorkItemType, WorkItemDefaultsScope>> = {};
  if (specObj.kinds !== undefined && specObj.kinds !== null) {
    if (typeof specObj.kinds !== "object" || Array.isArray(specObj.kinds)) {
      issues.push(here("WorkItemDefaults spec.kinds must be a mapping"));
    } else {
      for (const [kindName, rawScope] of Object.entries(specObj.kinds as Record<string, unknown>)) {
        if (!WORK_ITEM_TYPES.includes(kindName as WorkItemType)) {
          issues.push(
            here(`WorkItemDefaults spec.kinds key ${kindName} is not a known work item type`),
          );
          continue;
        }
        const scope = parseDefaultsScope(rawScope, path, documentIndex, `spec.kinds.${kindName}`);
        if ("issue" in scope) {
          issues.push(scope.issue);
          continue;
        }
        if (scope.value !== undefined) kinds[kindName as WorkItemType] = scope.value;
      }
    }
  }

  const globalValue = "value" in global ? global.value : undefined;
  return {
    defaults: {
      ...(globalValue ? { global: globalValue } : {}),
      ...(Object.keys(kinds).length > 0 ? { kinds } : {}),
      source: { path, documentIndex },
    },
    issues,
  };
}

function parseDefaultsScope(
  raw: unknown,
  path: string,
  documentIndex: number,
  label: string,
): { value?: WorkItemDefaultsScope } | { issue: ValidationIssue } {
  // null/undefined scope (`Feature:` with no body, or `Feature: null`) is
  // valid and contributes nothing — a comment-only block parses to null.
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      issue: {
        severity: "warning",
        code: "template_malformed",
        message: `WorkItemDefaults ${label} must be a mapping`,
        yamlPath: path,
        yamlDocumentIndex: documentIndex,
      },
    };
  }
  const obj = raw as Record<string, unknown>;
  const scope: WorkItemDefaultsScope = {};

  // metadata/fields can be null when the user comments out all entries
  // (`fields:` with only comments parses to null). Treat null as "no
  // entries" rather than malformed.
  if (obj.metadata !== undefined && obj.metadata !== null) {
    if (typeof obj.metadata !== "object" || Array.isArray(obj.metadata)) {
      return {
        issue: {
          severity: "warning",
          code: "template_malformed",
          message: `WorkItemDefaults ${label}.metadata must be a mapping`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    scope.metadata = { ...(obj.metadata as Record<string, unknown>) };
  }

  if (obj.fields !== undefined && obj.fields !== null) {
    if (typeof obj.fields !== "object" || Array.isArray(obj.fields)) {
      return {
        issue: {
          severity: "warning",
          code: "template_malformed",
          message: `WorkItemDefaults ${label}.fields must be a mapping`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    scope.fields = { ...(obj.fields as Record<string, unknown>) };
  }

  if (obj.tags !== undefined && obj.tags !== null) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === "string")) {
      return {
        issue: {
          severity: "warning",
          code: "template_malformed",
          message: `WorkItemDefaults ${label}.tags must be an array of strings`,
          yamlPath: path,
          yamlDocumentIndex: documentIndex,
        },
      };
    }
    scope.tags = [...(obj.tags as string[])];
  }

  return { value: Object.keys(scope).length > 0 ? scope : undefined };
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
