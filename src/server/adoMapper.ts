// Maps ADO work items into Surfboard's LocalWorkItem shape per spec §5.3.
// - System.Tags (semicolon-delimited) becomes spec.tags (array).
// - The Hierarchy-Reverse relation OR System.Parent becomes spec.parent.adoId.
// - Server-managed and read-only fields are stripped.

import type { AdoRelation, AdoWorkItem } from "./adoClient.ts";
import { HIERARCHY_REVERSE_REL, SYSTEM_TAGS_FIELD } from "../shared/constants.ts";
import type { LocalWorkItem, WorkItemType } from "../shared/types.ts";

export type AdoMapOptions = {
  yamlPath: string;
  yamlDocumentIndex: number;
  /** Override the kind derivation (e.g. when a project uses non-standard work item type names). */
  typeMap?: Record<string, WorkItemType>;
  /** When provided, populates spec.parent.localId for known parent ADO IDs. */
  localIdByAdoId?: ReadonlyMap<number, string>;
  /** Override how a default localId is generated when no cache lookup applies. */
  deriveLocalId?: (item: AdoWorkItem, kind: WorkItemType) => string;
};

const DEFAULT_TYPE_MAP: Record<string, WorkItemType> = {
  Epic: "Epic",
  Feature: "Feature",
  PBI: "PBI",
  "Product Backlog Item": "PBI",
  Enabler: "Enabler",
  Task: "Task",
};

const STRIP_FIELDS = new Set<string>([
  "System.Id",
  "System.Rev",
  "System.WorkItemType",
  "System.Parent",
  "System.IsDeleted",
  "System.Tags",
  "System.AuthorizedAs",
  "System.AuthorizedDate",
  "System.ChangedBy",
  "System.ChangedDate",
  "System.CreatedBy",
  "System.CreatedDate",
  "System.History",
  "System.PersonId",
  "System.RevisedDate",
  "System.Watermark",
  "System.NodeName",
  "System.TeamProject",
  "System.AreaId",
  "System.IterationId",
  "System.AreaLevel1",
  "System.AreaLevel2",
  "System.AreaLevel3",
  "System.AreaLevel4",
  "System.IterationLevel1",
  "System.IterationLevel2",
  "System.IterationLevel3",
  "System.BoardColumn",
  "System.BoardColumnDone",
  "System.BoardLane",
  "System.CommentCount",
  "System.RelatedLinkCount",
  "System.HyperLinkCount",
  "System.AttachedFileCount",
  "System.ExternalLinkCount",
]);

export function mapAdoToLocal(item: AdoWorkItem, options: AdoMapOptions): LocalWorkItem {
  const witName = item.fields["System.WorkItemType"];
  if (typeof witName !== "string") {
    throw new Error(`ADO item ${item.id} has no System.WorkItemType`);
  }
  const typeMap = { ...DEFAULT_TYPE_MAP, ...options.typeMap };
  const kind = typeMap[witName];
  if (!kind) {
    throw new Error(`Unknown ADO work item type: ${witName}`);
  }

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item.fields)) {
    if (STRIP_FIELDS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.length === 0) continue;
    fields[k] = v;
  }

  const tags = mapAdoTagsToSpec(item.fields[SYSTEM_TAGS_FIELD]);
  const parent = deriveParent(item, options.localIdByAdoId);

  const localIdFn = options.deriveLocalId ?? defaultDeriveLocalId;
  const localId =
    options.localIdByAdoId?.get(item.id) ?? localIdFn(item, kind);

  return {
    apiVersion: "surfboard.ado/v1",
    kind,
    metadata: {
      localId,
      adoId: item.id,
    },
    spec: {
      ...(parent ? { parent } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      fields,
    },
    yamlPath: options.yamlPath,
    yamlDocumentIndex: options.yamlDocumentIndex,
  };
}

export function mapAdoTagsToSpec(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

export function mapSpecTagsToAdo(tags: readonly string[] | undefined): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  const seen = new Set<string>();
  for (const t of tags) {
    const trimmed = t.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  if (seen.size === 0) return undefined;
  return [...seen].join("; ");
}

function deriveParent(
  item: AdoWorkItem,
  localIdByAdoId?: ReadonlyMap<number, string>,
): { localId?: string; adoId: number } | undefined {
  // Prefer System.Parent because it's authoritative.
  const sysParent = item.fields["System.Parent"];
  if (typeof sysParent === "number" && Number.isInteger(sysParent) && sysParent > 0) {
    return {
      adoId: sysParent,
      ...(localIdByAdoId?.get(sysParent) ? { localId: localIdByAdoId.get(sysParent) } : {}),
    };
  }
  // Otherwise look at relations for a Hierarchy-Reverse edge.
  const reverse = item.relations?.find((r) => r.rel === HIERARCHY_REVERSE_REL);
  if (reverse) {
    const id = parseAdoIdFromUrl(reverse.url);
    if (id !== null) {
      return {
        adoId: id,
        ...(localIdByAdoId?.get(id) ? { localId: localIdByAdoId.get(id) } : {}),
      };
    }
  }
  return undefined;
}

export function parseAdoIdFromUrl(url: string): number | null {
  // URL form: https://dev.azure.com/{org}/_apis/wit/workItems/{id}
  // Tolerate trailing /, query strings, and case differences.
  const match = url.match(/workItems\/(\d+)(?:[/?]|$)/i);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function defaultDeriveLocalId(item: AdoWorkItem, kind: WorkItemType): string {
  return `${kind.toLowerCase()}-${item.id}`;
}

// Helper for ignored relations during fixture audits.
export function isHierarchyReverse(rel: AdoRelation): boolean {
  return rel.rel === HIERARCHY_REVERSE_REL;
}
