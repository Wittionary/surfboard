import type { CachedWorkItem, LocalWorkItem, WorkItemSelector } from "../shared/types.ts";
import type { WorkspaceDocument } from "./workspace.ts";

export function matchesSelector(
  item: LocalWorkItem | undefined,
  selector: WorkItemSelector,
): boolean {
  if (!item) return false;
  if (selector.localId !== undefined && item.metadata.localId === selector.localId) return true;
  if (selector.adoId !== undefined && item.metadata.adoId === selector.adoId) return true;
  return false;
}

export function findDocumentBySelector(
  documents: readonly WorkspaceDocument[],
  selector: WorkItemSelector,
): WorkspaceDocument | undefined {
  return documents.find((d) => matchesSelector(d.item, selector));
}

export function referencesParent(child: LocalWorkItem, parent: LocalWorkItem): boolean {
  const ref = child.spec.parent;
  if (!ref) return false;
  if (ref.localId === parent.metadata.localId) return true;
  if (parent.metadata.adoId !== undefined && ref.adoId === parent.metadata.adoId) return true;
  return false;
}

export function findDirectChildDocuments(
  documents: readonly WorkspaceDocument[],
  parent: LocalWorkItem,
): WorkspaceDocument[] {
  return documents.filter((d) => (d.item ? referencesParent(d.item, parent) : false));
}

export function buildLocalIdLookup(cached: readonly CachedWorkItem[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const row of cached) {
    if (row.adoId !== undefined) map.set(row.adoId, row.localId);
  }
  return map;
}
