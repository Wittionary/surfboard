// JSON Patch builders for ADO create + update per spec §11.3 and §11.4.
//
// Hard rules:
// - Every update patch begins with `{op: "test", path: "/rev", value: <cachedRev>}`.
// - System.Tags is serialized to ADO's semicolon-delimited form.
// - Parent relation changes are explicit: remove + add, never silent.

import type { AdoJsonPatchOp, AdoRelation, AdoWorkItem } from "./adoClient.ts";
import { mapSpecTagsToAdo } from "./adoMapper.ts";
import {
  HIERARCHY_REVERSE_REL,
  SYSTEM_TAGS_FIELD,
} from "../shared/constants.ts";
import type { LocalWorkItem } from "../shared/types.ts";

export type CreatePatchInput = {
  item: LocalWorkItem;
  /** ADO work item URL of the parent. Required for child creates; omit for Epic. */
  parentUrl?: string;
};

export function buildCreatePatch(input: CreatePatchInput): AdoJsonPatchOp[] {
  const { item, parentUrl } = input;
  const ops: AdoJsonPatchOp[] = [];

  for (const [name, value] of Object.entries(item.spec.fields)) {
    if (value === undefined || value === null) continue;
    ops.push({ op: "add", path: `/fields/${name}`, value });
  }
  const tagsString = mapSpecTagsToAdo(item.spec.tags);
  if (tagsString !== undefined) {
    ops.push({ op: "add", path: `/fields/${SYSTEM_TAGS_FIELD}`, value: tagsString });
  }
  if (parentUrl) {
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: HIERARCHY_REVERSE_REL, url: parentUrl } satisfies AdoRelation,
    });
  }
  return ops;
}

export type UpdatePatchInput = {
  item: LocalWorkItem;
  /** Baseline revision the patch is conditional on (the test op uses this). */
  cachedRev: number;
  /** Latest remote work item; used to compute the index of the existing parent relation when reparenting. */
  remote: AdoWorkItem;
  /** When provided and different from the remote relation's URL, the patch removes the existing parent relation and adds the new one. */
  newParentUrl?: string;
};

export function buildUpdatePatch(input: UpdatePatchInput): AdoJsonPatchOp[] {
  const { item, cachedRev, remote, newParentUrl } = input;
  const ops: AdoJsonPatchOp[] = [];

  // Hard rule: test op for /rev must come first.
  ops.push({ op: "test", path: "/rev", value: cachedRev });

  // Update each field present locally. ADO treats no-op replace as inert, so
  // sending all fields is safe and avoids missing edits.
  for (const [name, value] of Object.entries(item.spec.fields)) {
    if (value === undefined || value === null) continue;
    ops.push({ op: "replace", path: `/fields/${name}`, value });
  }

  // Tags: replace as a single field with the canonical form. If tags were
  // present remotely and are absent locally, set to empty string so ADO
  // clears the tag list.
  const tagsLocal = mapSpecTagsToAdo(item.spec.tags);
  const tagsRemote = remote.fields[SYSTEM_TAGS_FIELD];
  if (tagsLocal !== undefined) {
    ops.push({ op: "replace", path: `/fields/${SYSTEM_TAGS_FIELD}`, value: tagsLocal });
  } else if (typeof tagsRemote === "string" && tagsRemote.length > 0) {
    ops.push({ op: "replace", path: `/fields/${SYSTEM_TAGS_FIELD}`, value: "" });
  }

  // Reparent: remove existing Hierarchy-Reverse relation by index, then add new one.
  if (newParentUrl) {
    const reverseIndex = (remote.relations ?? []).findIndex(
      (r) => r.rel === HIERARCHY_REVERSE_REL,
    );
    if (reverseIndex >= 0) {
      ops.push({ op: "remove", path: `/relations/${reverseIndex}` });
    }
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: HIERARCHY_REVERSE_REL, url: newParentUrl } satisfies AdoRelation,
    });
  }

  return ops;
}

/**
 * Convenience: detect whether the local YAML's parent reference points at a
 * different ADO ID than the remote item's existing parent relation.
 */
export function detectReparent(item: LocalWorkItem, remote: AdoWorkItem): boolean {
  const localParentAdoId = item.spec.parent?.adoId;
  const remoteRelation = (remote.relations ?? []).find((r) => r.rel === HIERARCHY_REVERSE_REL);
  const remoteParentId = remoteRelation
    ? Number.parseInt((remoteRelation.url.match(/workItems\/(\d+)/i)?.[1]) ?? "0", 10)
    : (typeof remote.fields["System.Parent"] === "number"
        ? (remote.fields["System.Parent"] as number)
        : 0);
  if (!localParentAdoId) return false;
  return remoteParentId !== localParentAdoId;
}

/**
 * Returns the URL ADO uses to identify a work item by ID. Centralized so the
 * patch builder doesn't hard-code the host.
 */
export function workItemUrl(organization: string, adoId: number): string {
  return `https://dev.azure.com/${organization}/_apis/wit/workItems/${adoId}`;
}
