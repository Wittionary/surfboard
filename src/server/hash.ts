// Canonical hashing helpers per spec §7. Field/relation hashes are computed
// from canonically normalized data so YAML formatting (key order, comments,
// quote style) does not produce false content changes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LocalWorkItem } from "../shared/types.ts";
import { SYSTEM_TAGS_FIELD } from "../shared/constants.ts";

export function fileSha256(content: Buffer | string): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/** SHA-256 of file contents, or undefined when the file is unreadable. */
export function safeFileHash(path: string): string | undefined {
  try {
    return fileSha256(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Canonical SHA-256 over the work item's `spec.fields` plus `spec.tags`.
 * Spec.tags is sorted and de-duplicated so reordering tags does not change
 * the hash. The Title is included as a normal field; this hash is what the
 * push engine compares to detect "the user changed something."
 */
export function fieldHash(item: LocalWorkItem): string {
  const fields: Record<string, unknown> = { ...item.spec.fields };
  if (item.spec.tags) {
    const normalized = uniqueSortedStrings(item.spec.tags);
    fields[SYSTEM_TAGS_FIELD] = normalized;
  }
  return canonicalSha256(fields);
}

/**
 * Canonical SHA-256 over the work item's relation state (currently just the
 * parent pointer). Reparenting changes this hash; field-only edits do not.
 */
export function relationHash(item: LocalWorkItem): string {
  const parent = item.spec.parent
    ? {
        localId: item.spec.parent.localId ?? null,
        adoId: item.spec.parent.adoId ?? null,
      }
    : null;
  return canonicalSha256({ parent });
}

/**
 * Canonical JSON-style serialization with sorted keys, recursively. Used by
 * `fieldHash` and `relationHash`. Exported so other modules can reuse the same
 * canonical form (e.g. for audit summaries).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value: unknown): string {
  return fileSha256(canonicalize(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalValue(obj[key]);
    }
    return out;
  }
  return value;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) seen.add(v);
  return [...seen].sort();
}
