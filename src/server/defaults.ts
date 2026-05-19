// Applies workspace defaults to a work item, producing an "effective" item
// without mutating the authored YAML model. Defaults flow:
//   global < kind < authored item.
// Metadata and spec.fields merge by key. spec.tags is replaced as a whole when
// the authored item provides tags.

import type { WorkItemDefaults, WorkItemDefaultsScope } from "./templateStore.ts";
import type { LocalWorkItem, WorkItemType } from "../shared/types.ts";

const PROTECTED_METADATA_KEYS = new Set<string>(["localId", "adoId"]);

export function applyDefaults(
  item: LocalWorkItem,
  defaults: WorkItemDefaults | undefined,
): LocalWorkItem {
  if (!defaults) return item;

  const scopes = effectiveScopes(defaults, item.kind);
  if (scopes.length === 0) return item;

  const effectiveMetadata = { ...item.metadata } as LocalWorkItem["metadata"];
  for (const scope of scopes) {
    if (!scope.metadata) continue;
    for (const [k, v] of Object.entries(scope.metadata)) {
      if (PROTECTED_METADATA_KEYS.has(k)) continue;
      if (k in effectiveMetadata) continue;
      (effectiveMetadata as Record<string, unknown>)[k] = v;
    }
  }
  // Authored metadata wins for protected and any keys already present.
  for (const [k, v] of Object.entries(item.metadata)) {
    (effectiveMetadata as Record<string, unknown>)[k] = v;
  }

  const effectiveFields: Record<string, unknown> = {};
  for (const scope of scopes) {
    if (!scope.fields) continue;
    for (const [k, v] of Object.entries(scope.fields)) {
      effectiveFields[k] = v;
    }
  }
  for (const [k, v] of Object.entries(item.spec.fields)) {
    effectiveFields[k] = v;
  }

  let effectiveTags: readonly string[] | undefined;
  if (item.spec.tags !== undefined) {
    effectiveTags = item.spec.tags;
  } else {
    for (const scope of scopes) {
      if (scope.tags !== undefined) effectiveTags = scope.tags;
    }
  }

  return {
    apiVersion: item.apiVersion,
    kind: item.kind,
    metadata: effectiveMetadata,
    spec: {
      ...(item.spec.parent ? { parent: item.spec.parent } : {}),
      ...(effectiveTags !== undefined ? { tags: [...effectiveTags] } : {}),
      fields: effectiveFields,
    },
    yamlPath: item.yamlPath,
    yamlDocumentIndex: item.yamlDocumentIndex,
  };
}

/**
 * Compares the value an authored item would inherit from defaults against the
 * value the authored item actually carries. Returns the set of (path, value)
 * keys that match the applicable defaults — used by pull writes to omit values
 * that defaults already supply.
 */
export function omitDefaults(
  item: LocalWorkItem,
  defaults: WorkItemDefaults | undefined,
): LocalWorkItem {
  if (!defaults) return item;
  const scopes = effectiveScopes(defaults, item.kind);
  if (scopes.length === 0) return item;

  // Combine global+kind into the "effective defaults" for this kind.
  const defaultFields: Record<string, unknown> = {};
  const defaultMetadata: Record<string, unknown> = {};
  let defaultTags: readonly string[] | undefined;
  for (const scope of scopes) {
    if (scope.fields) for (const [k, v] of Object.entries(scope.fields)) defaultFields[k] = v;
    if (scope.metadata) for (const [k, v] of Object.entries(scope.metadata)) defaultMetadata[k] = v;
    if (scope.tags !== undefined) defaultTags = scope.tags;
  }

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item.spec.fields)) {
    if (k in defaultFields && deepEqual(defaultFields[k], v)) continue;
    fields[k] = v;
  }

  const metadata: LocalWorkItem["metadata"] = { localId: item.metadata.localId };
  if (item.metadata.adoId !== undefined) metadata.adoId = item.metadata.adoId;
  for (const [k, v] of Object.entries(item.metadata)) {
    if (PROTECTED_METADATA_KEYS.has(k)) continue;
    if (k in defaultMetadata && deepEqual(defaultMetadata[k], v)) continue;
    (metadata as Record<string, unknown>)[k] = v;
  }

  let tags: readonly string[] | undefined = item.spec.tags;
  if (
    item.spec.tags !== undefined &&
    defaultTags !== undefined &&
    sameTagList(item.spec.tags, defaultTags)
  ) {
    tags = undefined;
  }

  return {
    apiVersion: item.apiVersion,
    kind: item.kind,
    metadata,
    spec: {
      ...(item.spec.parent ? { parent: item.spec.parent } : {}),
      ...(tags !== undefined ? { tags: [...tags] } : {}),
      fields,
    },
    yamlPath: item.yamlPath,
    yamlDocumentIndex: item.yamlDocumentIndex,
  };
}

function effectiveScopes(
  defaults: WorkItemDefaults,
  kind: WorkItemType,
): WorkItemDefaultsScope[] {
  const out: WorkItemDefaultsScope[] = [];
  if (defaults.global) out.push(defaults.global);
  const kindScope = defaults.kinds?.[kind];
  if (kindScope) out.push(kindScope);
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const key of ak) if (!deepEqual(ao[key], bo[key])) return false;
    return true;
  }
  return false;
}

function sameTagList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  for (let i = 0; i < aSorted.length; i++) {
    if (aSorted[i] !== bSorted[i]) return false;
  }
  return true;
}
