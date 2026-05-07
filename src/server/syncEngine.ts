// Pull and push orchestration per spec §13. Phase 3 implements pull
// (create-missing in Task 3.6, overwrite confirmation in Task 3.7). Phase 4
// adds push.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getDirectChildren,
  getWorkItem,
  isDeletedWorkItem,
  type AdoClient,
  type AdoWorkItem,
} from "./adoClient.ts";
import { mapAdoToLocal } from "./adoMapper.ts";
import {
  getAllCached,
  getCached,
  getCachedByAdoId,
  updateAcceptedBaseline,
  updateRemoteObserved,
  upsertWorkItemCache,
} from "./db.ts";
import { fieldHash, relationHash } from "./hash.ts";
import { appendDocument, writeDocument } from "./yamlStore.ts";
import type {
  ItemOperationResult,
  LocalWorkItem,
  OperationResult,
  PullOverwriteConfirmation,
  WorkItemSelector,
  WorkItemType,
} from "../shared/types.ts";

const KIND_DIR: Record<WorkItemType, string> = {
  Epic: "epics",
  Feature: "features",
  PBI: "pbis",
  Enabler: "enablers",
  Task: "tasks",
};

export type SyncEngineDeps = {
  client: AdoClient;
  db: Database;
  workspaceDir: string;
};

export type PullParentInput = {
  selector: WorkItemSelector;
  /** Caller-supplied confirmations for overwrite-yaml prompts. Phase 3.7 adds the data path. */
  confirmations?: readonly PullOverwriteConfirmation[];
};

/**
 * Pulls a parent and its direct children from ADO. Creates YAML files for
 * remote items that have no local representation. When a local YAML already
 * exists, the operation returns `requires_confirmation` if the remote rev has
 * advanced past the cached baseline and no matching confirmation was supplied
 * (see Task 3.7 for the confirmation-walk).
 */
export async function pullParentAndChildren(
  deps: SyncEngineDeps,
  input: PullParentInput,
): Promise<OperationResult> {
  const operationId = crypto.randomUUID();
  const items: ItemOperationResult[] = [];
  const summary = { validated: 0, created: 0, updated: 0, pulled: 0, blocked: 0, failed: 0 };

  let parent: AdoWorkItem;
  try {
    parent = await resolveParent(deps, input.selector);
  } catch (err) {
    items.push({
      action: "pull",
      status: "failed",
      errorCode: "parent_fetch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId: input.selector.localId,
      adoId: input.selector.adoId,
    });
    summary.failed += 1;
    return { operationId, status: "failed", summary, items };
  }

  if (isDeletedWorkItem(parent)) {
    items.push({
      action: "pull",
      status: "blocked",
      errorCode: "remote_deleted",
      errorMessage: `Parent ${parent.id} is deleted in ADO`,
      adoId: parent.id,
    });
    summary.blocked += 1;
    return { operationId, status: "blocked", summary, items };
  }

  const localIdByAdoId = buildLocalIdLookup(deps.db);
  const parentResult = pullSingle(deps, parent, localIdByAdoId, input.confirmations ?? []);
  items.push(parentResult);
  tallySummary(summary, parentResult);

  // Update lookup so children that reference this parent get the parent.localId.
  if (parentResult.status === "success" && parentResult.localId) {
    localIdByAdoId.set(parent.id, parentResult.localId);
  }

  let children: AdoWorkItem[] = [];
  try {
    children = await getDirectChildren(deps.client, parent.id);
  } catch (err) {
    items.push({
      action: "pull",
      status: "failed",
      errorCode: "children_fetch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      adoId: parent.id,
    });
    summary.failed += 1;
    return { operationId, status: "partial_failure", summary, items };
  }

  for (const child of children) {
    if (isDeletedWorkItem(child)) {
      items.push({
        action: "pull",
        status: "blocked",
        errorCode: "remote_deleted",
        adoId: child.id,
      });
      summary.blocked += 1;
      continue;
    }
    const childResult = pullSingle(deps, child, localIdByAdoId, input.confirmations ?? []);
    items.push(childResult);
    tallySummary(summary, childResult);
  }

  return { operationId, status: rollupStatus(summary), summary, items };
}

function rollupStatus(s: { failed: number; blocked: number }): OperationResult["status"] {
  if (s.failed > 0 && s.failed === blockedAndFailed(s)) return "failed";
  if (s.failed > 0 || s.blocked > 0) return "partial_failure";
  return "success";
}

function blockedAndFailed(s: { failed: number; blocked: number }): number {
  return s.failed + s.blocked;
}

function tallySummary(
  summary: OperationResult["summary"],
  result: ItemOperationResult,
): void {
  if (result.status === "success") {
    if (result.action === "pull" || result.action === "create" || result.action === "update") {
      summary.pulled += 1;
    }
  } else if (result.status === "blocked" || result.status === "requires_confirmation") {
    summary.blocked += 1;
  } else if (result.status === "failed") {
    summary.failed += 1;
  }
}

async function resolveParent(deps: SyncEngineDeps, selector: WorkItemSelector): Promise<AdoWorkItem> {
  if (selector.adoId !== undefined) {
    return getWorkItem(deps.client, selector.adoId);
  }
  if (selector.localId !== undefined) {
    const cached = getCached(deps.db, selector.localId);
    if (!cached?.adoId) {
      throw new Error(`Cannot resolve parent localId="${selector.localId}" — no cached ADO ID`);
    }
    return getWorkItem(deps.client, cached.adoId);
  }
  throw new Error("Pull selector requires localId or adoId");
}

function buildLocalIdLookup(db: Database): Map<number, string> {
  const map = new Map<number, string>();
  for (const c of getAllCached(db)) {
    if (c.adoId !== undefined) map.set(c.adoId, c.localId);
  }
  return map;
}

/**
 * Performs the create/skip/confirmation decision for a single remote item.
 * Phase 3.6 implements create-missing and skip-when-baseline-matches; Phase
 * 3.7 extends with overwrite-confirmation flow.
 */
function pullSingle(
  deps: SyncEngineDeps,
  remote: AdoWorkItem,
  localIdByAdoId: Map<number, string>,
  confirmations: readonly PullOverwriteConfirmation[],
): ItemOperationResult {
  const cached = getCachedByAdoId(deps.db, remote.id);

  if (!cached) {
    // Create-missing path.
    const local = mapAdoToLocal(remote, {
      yamlPath: "", // assigned below
      yamlDocumentIndex: 0,
      localIdByAdoId,
    });
    const targetPath = pickYamlPath(deps.workspaceDir, local);
    local.yamlPath = targetPath;
    local.yamlDocumentIndex = 0;

    const docIndex = appendDocument(targetPath, local);
    local.yamlDocumentIndex = docIndex;

    upsertWorkItemCache(deps.db, {
      localId: local.metadata.localId,
      adoId: remote.id,
      workItemType: local.kind,
      yamlPath: targetPath,
      yamlDocumentIndex: docIndex,
      parentLocalId: local.spec.parent?.localId,
      parentAdoId: local.spec.parent?.adoId,
      syncStatus: "synced",
    });
    updateAcceptedBaseline(deps.db, {
      localId: local.metadata.localId,
      adoId: remote.id,
      rev: remote.rev,
      fieldHash: fieldHash(local),
      relationHash: relationHash(local),
      syncStatus: "synced",
    });
    return {
      action: "create",
      status: "success",
      localId: local.metadata.localId,
      adoId: remote.id,
      workItemType: local.kind,
      yamlPath: targetPath,
      yamlDocumentIndex: docIndex,
      beforeRev: undefined,
      afterRev: remote.rev,
      cachedRev: undefined,
      remoteRev: remote.rev,
      syncStatus: "synced",
    };
  }

  // Cache row exists. If remote rev matches the accepted baseline, no work to do.
  if (cached.lastKnownRev === remote.rev) {
    return {
      action: "skip",
      status: "success",
      localId: cached.localId,
      adoId: remote.id,
      workItemType: cached.workItemType,
      yamlPath: cached.yamlPath,
      yamlDocumentIndex: cached.yamlDocumentIndex,
      cachedRev: cached.lastKnownRev,
      remoteRev: remote.rev,
      syncStatus: cached.syncStatus,
    };
  }

  // Remote diverged from cached baseline. Phase 3.7 wires the confirmation walk.
  const confirmation = confirmations.find(
    (c) => c.adoId === remote.id && c.remoteRev === remote.rev,
  );
  if (!confirmation) {
    updateRemoteObserved(deps.db, {
      localId: cached.localId,
      remoteRev: remote.rev,
      syncStatus: "remote_changed",
    });
    return {
      action: "pull",
      status: "requires_confirmation",
      confirmationRequired: "overwrite_yaml",
      localId: cached.localId,
      adoId: remote.id,
      workItemType: cached.workItemType,
      yamlPath: cached.yamlPath,
      yamlDocumentIndex: cached.yamlDocumentIndex,
      cachedRev: cached.lastKnownRev,
      remoteRev: remote.rev,
      syncStatus: "remote_changed",
    };
  }

  // Confirmed overwrite. Wire-up lives in Task 3.7.
  return overwriteYamlWithRemote(deps, cached.localId, remote, localIdByAdoId);
}

function overwriteYamlWithRemote(
  deps: SyncEngineDeps,
  localId: string,
  remote: AdoWorkItem,
  localIdByAdoId: Map<number, string>,
): ItemOperationResult {
  const cached = getCached(deps.db, localId);
  if (!cached) {
    return {
      action: "pull",
      status: "failed",
      errorCode: "cache_row_missing",
      errorMessage: `No cache row for ${localId} during overwrite`,
      localId,
      adoId: remote.id,
    };
  }

  // Map the remote item, but keep the same localId so the workspace identity
  // is stable across the overwrite.
  const local = mapAdoToLocal(remote, {
    yamlPath: cached.yamlPath,
    yamlDocumentIndex: cached.yamlDocumentIndex,
    localIdByAdoId,
    deriveLocalId: () => localId,
  });

  try {
    writeDocument(cached.yamlPath, cached.yamlDocumentIndex, local);
  } catch (err) {
    return {
      action: "pull",
      status: "failed",
      errorCode: "yaml_write_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId,
      adoId: remote.id,
      cachedRev: cached.lastKnownRev,
      remoteRev: remote.rev,
      yamlPath: cached.yamlPath,
      yamlDocumentIndex: cached.yamlDocumentIndex,
    };
  }

  upsertWorkItemCache(deps.db, {
    localId,
    adoId: remote.id,
    workItemType: local.kind,
    yamlPath: cached.yamlPath,
    yamlDocumentIndex: cached.yamlDocumentIndex,
    parentLocalId: local.spec.parent?.localId,
    parentAdoId: local.spec.parent?.adoId,
    syncStatus: "synced",
  });
  updateAcceptedBaseline(deps.db, {
    localId,
    adoId: remote.id,
    rev: remote.rev,
    fieldHash: fieldHash(local),
    relationHash: relationHash(local),
    syncStatus: "synced",
  });
  return {
    action: "update",
    status: "success",
    localId,
    adoId: remote.id,
    workItemType: local.kind,
    yamlPath: cached.yamlPath,
    yamlDocumentIndex: cached.yamlDocumentIndex,
    beforeRev: cached.lastKnownRev,
    afterRev: remote.rev,
    cachedRev: cached.lastKnownRev,
    remoteRev: remote.rev,
    syncStatus: "synced",
  };
}

function pickYamlPath(workspaceDir: string, item: LocalWorkItem): string {
  const dir = resolve(workspaceDir, "workitems", KIND_DIR[item.kind]);
  const file = `${item.metadata.localId}.yaml`;
  let candidate = join(dir, file);
  if (!existsSync(candidate)) return candidate;
  // Append numeric suffix if a file already exists with the same name.
  let i = 2;
  while (existsSync((candidate = join(dir, `${item.metadata.localId}-${i}.yaml`)))) {
    i += 1;
  }
  return candidate;
}

/**
 * Returns the current rev that ADO reports for the given remote item.
 * Convenience wrapper used by routes that want to refresh status without
 * pulling.
 */
export async function probeRemoteRev(
  deps: Pick<SyncEngineDeps, "client">,
  adoId: number,
): Promise<{ rev: number; deleted: boolean }> {
  const item = await getWorkItem(deps.client, adoId);
  return { rev: item.rev, deleted: isDeletedWorkItem(item) };
}

