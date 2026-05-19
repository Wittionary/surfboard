// Pull and push orchestration per spec §13. Phase 3 implements pull
// (create-missing in Task 3.6, overwrite confirmation in Task 3.7). Phase 4
// adds push.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  AdoError,
  getDirectChildren,
  getWorkItem,
  getWorkItems,
  isDeletedWorkItem,
  type AdoClient,
  type AdoWorkItem,
} from "./adoClient.ts";
import { mapAdoToLocal } from "./adoMapper.ts";
import {
  buildCreatePatch,
  buildUpdatePatch,
  detectReparent,
  workItemUrl,
} from "./patchBuilder.ts";
import { safeFileHash } from "./hash.ts";
import {
  PARENT_MATRIX,
  WORK_ITEM_KINDS_REQUIRING_PARENT,
} from "../shared/constants.ts";
import { parseYamlFile } from "./yamlStore.ts";
import type { ValidationIssue } from "../shared/types.ts";
import { validateDocument, validateWorkspace } from "./validator.ts";
import { loadTemplates, type WorkItemDefaults } from "./templateStore.ts";
import { applyDefaults, omitDefaults } from "./defaults.ts";
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
import { auditFor } from "./syncAudit.ts";
import {
  emptyOperationSummary,
  rollupStatus,
  tallyPullSummary,
  tallyPushSummary,
} from "./syncResult.ts";
import {
  buildLocalIdLookup as buildLocalIdLookupFromCache,
  referencesParent,
} from "./workItemRefs.ts";
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

export { probeRemoteRev, refreshRemoteStatus, type RemoteDiagnostic } from "./remoteStatus.ts";

export type SyncEngineDeps = {
  client: AdoClient;
  db: Database;
  workspaceDir: string;
  /**
   * Template directory containing WorkItemTemplate and (optionally)
   * WorkItemDefaults documents. When omitted, falls back to
   * `<workspaceDir>/templates`. Always pass this explicitly from routes —
   * otherwise defaults silently won't load when ADO_TEMPLATE_DIR is set to
   * a non-conventional path.
   */
  templateDir?: string;
  /** When provided, audit_log rows scrub this PAT from any request/response summaries. */
  pat?: string;
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
  const summary = emptyOperationSummary();

  let parent: AdoWorkItem;
  try {
    parent = await resolveParent(deps, input.selector);
  } catch (err) {
    const failed: ItemOperationResult = {
      action: "pull",
      status: "failed",
      errorCode: "parent_fetch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId: input.selector.localId,
      adoId: input.selector.adoId,
    };
    items.push(failed);
    summary.failed += 1;
    auditFor(deps, operationId, failed, input);
    return { operationId, status: "failed", summary, items };
  }

  if (isDeletedWorkItem(parent)) {
    const blocked: ItemOperationResult = {
      action: "pull",
      status: "blocked",
      errorCode: "remote_deleted",
      errorMessage: `Parent ${parent.id} is deleted in ADO`,
      adoId: parent.id,
    };
    items.push(blocked);
    summary.blocked += 1;
    auditFor(deps, operationId, blocked, input);
    return { operationId, status: "blocked", summary, items };
  }

  const localIdByAdoId = buildLocalIdLookupFromCache(getAllCached(deps.db));
  const parentResult = pullSingle(deps, parent, localIdByAdoId, input.confirmations ?? []);
  items.push(parentResult);
  tallyPullSummary(summary, parentResult);
  auditFor(deps, operationId, parentResult, input);

  // Update lookup so children that reference this parent get the parent.localId.
  if (parentResult.status === "success" && parentResult.localId) {
    localIdByAdoId.set(parent.id, parentResult.localId);
  }

  let children: AdoWorkItem[] = [];
  try {
    children = await getDirectChildren(deps.client, parent.id);
  } catch (err) {
    const failed: ItemOperationResult = {
      action: "pull",
      status: "failed",
      errorCode: "children_fetch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      adoId: parent.id,
    };
    items.push(failed);
    summary.failed += 1;
    auditFor(deps, operationId, failed, input);
    return { operationId, status: "partial_failure", summary, items };
  }

  for (const child of children) {
    if (isDeletedWorkItem(child)) {
      const blocked: ItemOperationResult = {
        action: "pull",
        status: "blocked",
        errorCode: "remote_deleted",
        errorMessage: `ADO #${child.id} was deleted remotely`,
        adoId: child.id,
      };
      items.push(blocked);
      summary.blocked += 1;
      auditFor(deps, operationId, blocked, input);
      continue;
    }
    const childResult = pullSingle(deps, child, localIdByAdoId, input.confirmations ?? []);
    items.push(childResult);
    tallyPullSummary(summary, childResult);
    auditFor(deps, operationId, childResult, input);
  }

  return { operationId, status: rollupStatus(summary), summary, items };
}

/**
 * Pulls a single item (no children) — used by POST /api/pull/item.
 */
export type PullItemInput = {
  selector: WorkItemSelector;
  confirmation?: PullOverwriteConfirmation;
};

export async function pullSingleItem(
  deps: SyncEngineDeps,
  input: PullItemInput,
): Promise<OperationResult> {
  const operationId = crypto.randomUUID();
  const items: ItemOperationResult[] = [];
  const summary = emptyOperationSummary();

  let remote: AdoWorkItem;
  try {
    remote = await resolveParent(deps, input.selector);
  } catch (err) {
    const failed: ItemOperationResult = {
      action: "pull",
      status: "failed",
      errorCode: "fetch_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId: input.selector.localId,
      adoId: input.selector.adoId,
    };
    items.push(failed);
    summary.failed += 1;
    auditFor(deps, operationId, failed, input);
    return { operationId, status: "failed", summary, items };
  }

  if (isDeletedWorkItem(remote)) {
    const blocked: ItemOperationResult = {
      action: "pull",
      status: "blocked",
      errorCode: "remote_deleted",
      errorMessage: `ADO #${remote.id} was deleted remotely`,
      adoId: remote.id,
    };
    items.push(blocked);
    summary.blocked += 1;
    auditFor(deps, operationId, blocked, input);
    return { operationId, status: "blocked", summary, items };
  }

  const result = pullSingle(
    deps,
    remote,
    buildLocalIdLookupFromCache(getAllCached(deps.db)),
    input.confirmation ? [input.confirmation] : [],
  );
  items.push(result);
  tallyPullSummary(summary, result);
  auditFor(deps, operationId, result, input);
  return { operationId, status: rollupStatus(summary), summary, items };
}

// ---------------------------------------------------------------------------
// Push engine (Tasks 4.2 – 4.6 + 4.7)
// ---------------------------------------------------------------------------

export type PushAllInput = {
  parent: WorkItemSelector;
  /** When true, include the selected parent in the push set (update only — MVP does not create parents). */
  includeParent?: boolean;
  /** When provided, restrict child operations to these local IDs. */
  childLocalIds?: readonly string[];
  /** Local IDs whose parent change has been explicitly confirmed by the user. */
  confirmedParentChanges?: readonly string[];
};

export type PushItemInput = {
  selector: WorkItemSelector;
  confirmedParentChange?: boolean;
};

type PushPlanItem = {
  /** The work item document we intend to push. */
  local: LocalWorkItem;
  /** Cache row, if the local already maps to an ADO ID. Missing means "create". */
  cached?: ReturnType<typeof getCached>;
  /** True for the selected parent, used by ordering. */
  isParent: boolean;
  /** Whether we expect to create vs update. */
  intent: "create" | "update";
  /** Hash of the YAML file at plan time; checked again before execution per spec §13.1. */
  fileHashAtPlan: string | undefined;
  /** True when reparenting was detected. */
  isReparent?: boolean;
};

export async function pushParentAndChildren(
  deps: SyncEngineDeps,
  input: PushAllInput,
): Promise<OperationResult> {
  const operationId = crypto.randomUUID();
  const items: ItemOperationResult[] = [];
  const summary = emptyOperationSummary();

  // Collect candidate documents from the workspace.
  const allDocs = parseAllWorkspaceDocs(deps);
  const allLocals: LocalWorkItem[] = [];
  for (const doc of allDocs) {
    if (doc.content) allLocals.push(doc.content);
  }
  // Workspace-wide duplicate check before we dedupe by localId.
  const duplicateIssues = validateWorkspace(allLocals).issues.filter(
    (i) => i.code === "duplicate_local_id",
  );
  if (duplicateIssues.length > 0) {
    for (const issue of duplicateIssues) {
      const result: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: issue.code,
        errorMessage: issue.message,
        localId: issue.localId,
        yamlPath: issue.yamlPath,
        yamlDocumentIndex: issue.yamlDocumentIndex,
        validationIssues: [issue],
      };
      items.push(result);
      summary.blocked += 1;
      auditFor(deps, operationId, result, input);
    }
    return { operationId, status: "blocked", summary, items };
  }
  const itemsByLocalId = new Map<string, LocalWorkItem>();
  for (const item of allLocals) {
    itemsByLocalId.set(item.metadata.localId, item);
  }

  // Resolve parent.
  const parentLocal = resolveLocalForSelector(deps, itemsByLocalId, input.parent);
  if (!parentLocal) {
    items.push({
      action: "block",
      status: "blocked",
      errorCode: "unknown_parent_local_id",
      errorMessage: `No local work item matches selector ${JSON.stringify(input.parent)}`,
      localId: input.parent.localId,
      adoId: input.parent.adoId,
    });
    summary.blocked += 1;
    auditFor(deps, operationId, items[0]!, input);
    return { operationId, status: "blocked", summary, items };
  }
  if (input.includeParent && !parentLocal.metadata.adoId) {
    items.push({
      action: "block",
      status: "blocked",
      errorCode: "create_parent_not_supported",
      errorMessage: "Parent creation is out of scope for MVP",
      localId: parentLocal.metadata.localId,
    });
    summary.blocked += 1;
    auditFor(deps, operationId, items[0]!, input);
    return { operationId, status: "blocked", summary, items };
  }

  // Determine child set.
  const childCandidates = [...itemsByLocalId.values()].filter(
    (i) => i !== parentLocal && referencesParent(i, parentLocal),
  );
  const targetChildren = input.childLocalIds && input.childLocalIds.length > 0
    ? childCandidates.filter((c) => input.childLocalIds!.includes(c.metadata.localId))
    : childCandidates;

  // Prevalidation across the full set including the parent.
  const planSet: LocalWorkItem[] = [];
  if (input.includeParent) planSet.push(parentLocal);
  planSet.push(...targetChildren);

  const prevalidationIssues = prevalidate(deps, planSet);
  const blockingIssues = prevalidationIssues.filter((i) => i.severity === "error");
  if (blockingIssues.length > 0) {
    for (const issue of blockingIssues) {
      const result: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: issue.code,
        errorMessage: issue.message,
        localId: issue.localId,
        yamlPath: issue.yamlPath,
        yamlDocumentIndex: issue.yamlDocumentIndex,
        validationIssues: [issue],
      };
      items.push(result);
      summary.blocked += 1;
      auditFor(deps, operationId, result, input);
    }
    return { operationId, status: "blocked", summary, items };
  }

  // Build plan with file hashes captured.
  const plan: PushPlanItem[] = [];
  for (const local of planSet) {
    const cached = local.metadata.adoId ? getCached(deps.db, local.metadata.localId) : undefined;
    const intent: "create" | "update" = local.metadata.adoId ? "update" : "create";
    plan.push({
      local,
      cached,
      isParent: local === parentLocal,
      intent,
      fileHashAtPlan: safeFileHash(local.yamlPath),
    });
  }

  // Fetch latest remote state for items that already exist in ADO.
  const existingIds = plan
    .filter((p) => p.intent === "update" && p.local.metadata.adoId !== undefined)
    .map((p) => p.local.metadata.adoId as number);
  let remoteByAdoId = new Map<number, AdoWorkItem>();
  if (existingIds.length > 0) {
    try {
      const remotes = await getWorkItems(deps.client, existingIds);
      for (const r of remotes) remoteByAdoId.set(r.id, r);
    } catch (err) {
      const failed: ItemOperationResult = {
        action: "block",
        status: "failed",
        errorCode: "remote_fetch_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      items.push(failed);
      summary.failed += 1;
      auditFor(deps, operationId, failed, input);
      return { operationId, status: "failed", summary, items };
    }
  }

  // Block on remote drift / deletion / unconfirmed parent changes.
  for (const p of plan) {
    if (p.intent !== "update") continue;
    const adoId = p.local.metadata.adoId as number;
    const remote = remoteByAdoId.get(adoId);
    if (!remote || isDeletedWorkItem(remote)) {
      const blocked: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: "remote_deleted",
        errorMessage: `ADO #${adoId} was deleted remotely`,
        localId: p.local.metadata.localId,
        adoId,
        cachedRev: p.cached?.lastKnownRev,
        syncStatus: "deleted_remotely",
      };
      items.push(blocked);
      summary.blocked += 1;
      auditFor(deps, operationId, blocked, input);
      return { operationId, status: "blocked", summary, items };
    }
    if (p.cached?.lastKnownRev === undefined) {
      const blocked: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: "missing_cached_revision",
        errorMessage: `'${p.local.metadata.localId}' (ADO #${adoId}) has no pull baseline — pull this item before pushing`,
        localId: p.local.metadata.localId,
        adoId,
        remoteRev: remote.rev,
        syncStatus: "conflict_blocked",
      };
      items.push(blocked);
      summary.blocked += 1;
      auditFor(deps, operationId, blocked, input);
      return { operationId, status: "blocked", summary, items };
    }
    if (remote.rev !== p.cached.lastKnownRev) {
      updateRemoteObserved(deps.db, {
        localId: p.local.metadata.localId,
        remoteRev: remote.rev,
        syncStatus: "remote_changed",
      });
      const blocked: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: "remote_revision_changed",
        errorMessage: `'${p.local.metadata.localId}' (ADO #${adoId}) changed remotely: cached rev ${p.cached.lastKnownRev}, remote rev ${remote.rev} — pull first`,
        localId: p.local.metadata.localId,
        adoId,
        cachedRev: p.cached.lastKnownRev,
        remoteRev: remote.rev,
        syncStatus: "remote_changed",
      };
      items.push(blocked);
      summary.blocked += 1;
      auditFor(deps, operationId, blocked, input);
      return { operationId, status: "blocked", summary, items };
    }
    if (detectReparent(p.local, remote)) {
      const confirmed = (input.confirmedParentChanges ?? []).includes(p.local.metadata.localId);
      if (!confirmed) {
        const blocked: ItemOperationResult = {
          action: "block",
          status: "requires_confirmation",
          confirmationRequired: "change_parent",
          localId: p.local.metadata.localId,
          adoId,
          cachedRev: p.cached.lastKnownRev,
          remoteRev: remote.rev,
        };
        items.push(blocked);
        summary.blocked += 1;
        auditFor(deps, operationId, blocked, input);
        return { operationId, status: "blocked", summary, items };
      }
      p.isReparent = true;
    }
  }

  // Order: parent first, then children. Ordering inside children is by localId.
  plan.sort((a, b) => {
    if (a.isParent !== b.isParent) return a.isParent ? -1 : 1;
    return a.local.metadata.localId.localeCompare(b.local.metadata.localId);
  });

  // Sequential execution. Stop on first failure.
  for (const step of plan) {
    // File hash drift check immediately before execution.
    const currentHash = safeFileHash(step.local.yamlPath);
    if (currentHash !== step.fileHashAtPlan) {
      const blocked: ItemOperationResult = {
        action: "block",
        status: "blocked",
        errorCode: "yaml_changed_during_push",
        errorMessage: `'${step.local.metadata.localId}' YAML file changed on disk since the push started — retry`,
        localId: step.local.metadata.localId,
        yamlPath: step.local.yamlPath,
        yamlDocumentIndex: step.local.yamlDocumentIndex,
      };
      items.push(blocked);
      summary.blocked += 1;
      auditFor(deps, operationId, blocked, input);
      return { operationId, status: "blocked", summary, items };
    }

    if (step.intent === "create") {
      const result = await executeCreate(deps, step, parentLocal);
      items.push(result);
      tallyPushSummary(summary, result);
      auditFor(deps, operationId, result, input);
      if (result.status !== "success") {
        return { operationId, status: "partial_failure", summary, items };
      }
    } else {
      const remote = remoteByAdoId.get(step.local.metadata.adoId as number);
      if (!remote) continue; // shouldn't happen; we'd have blocked above.
      const result = await executeUpdate(deps, step, remote);
      items.push(result);
      tallyPushSummary(summary, result);
      auditFor(deps, operationId, result, input);
      if (result.status !== "success") {
        return { operationId, status: "partial_failure", summary, items };
      }
    }
  }

  return { operationId, status: rollupStatus(summary), summary, items };
}

export async function pushSingleItem(
  deps: SyncEngineDeps,
  input: PushItemInput,
): Promise<OperationResult> {
  // Resolve which document we're pushing.
  const allDocs = parseAllWorkspaceDocs(deps);
  const itemsByLocalId = new Map<string, LocalWorkItem>();
  for (const doc of allDocs) {
    if (doc.content) itemsByLocalId.set(doc.content.metadata.localId, doc.content);
  }
  const target = resolveLocalForSelector(deps, itemsByLocalId, input.selector);
  if (!target) {
    const operationId = crypto.randomUUID();
    const blocked: ItemOperationResult = {
      action: "block",
      status: "blocked",
      errorCode: "item_not_found",
      errorMessage: `No local work item matches selector ${JSON.stringify(input.selector)}`,
      localId: input.selector.localId,
      adoId: input.selector.adoId,
    };
    auditFor(deps, operationId, blocked, input);
    return {
      operationId,
      status: "blocked",
      summary: { validated: 0, created: 0, updated: 0, pulled: 0, blocked: 1, failed: 0 },
      items: [blocked],
    };
  }
  // Reuse pushParentAndChildren by restricting the set.
  // For a single-item push: treat the target as a "parent" for ordering, but
  // mark its ancestor as the actual structural parent so children are not
  // pulled in.
  return pushParentAndChildren(deps, {
    parent: { localId: target.metadata.localId, adoId: target.metadata.adoId },
    includeParent: true,
    childLocalIds: [],
    confirmedParentChanges: input.confirmedParentChange ? [target.metadata.localId] : [],
  });
}

function parseAllWorkspaceDocs(deps: SyncEngineDeps): ReturnType<typeof parseYamlFile> {
  const cached = getAllCached(deps.db);
  const visited = new Set<string>();
  const docs: ReturnType<typeof parseYamlFile> = [];
  for (const c of cached) {
    if (visited.has(c.yamlPath)) continue;
    visited.add(c.yamlPath);
    if (!existsSync(c.yamlPath)) continue;
    docs.push(...parseYamlFile(c.yamlPath));
  }
  return docs;
}

function resolveLocalForSelector(
  deps: SyncEngineDeps,
  itemsByLocalId: Map<string, LocalWorkItem>,
  selector: WorkItemSelector,
): LocalWorkItem | null {
  if (selector.localId) {
    return itemsByLocalId.get(selector.localId) ?? null;
  }
  if (selector.adoId !== undefined) {
    const cached = getCachedByAdoId(deps.db, selector.adoId);
    if (!cached) return null;
    return itemsByLocalId.get(cached.localId) ?? null;
  }
  return null;
}

function prevalidate(
  deps: SyncEngineDeps,
  set: readonly LocalWorkItem[],
): ValidationIssue[] {
  if (set.length === 0) return [];
  const templates = loadDeps(deps);
  const defaults = templates.defaults;
  const issues: ValidationIssue[] = [];

  // Per-document schema validation. Validate authored raw, but defaults
  // satisfy required-field and type/enum checks.
  for (const item of set) {
    const docIssues = validateDocument(
      {
        path: item.yamlPath,
        documentIndex: item.yamlDocumentIndex,
        raw: { apiVersion: item.apiVersion, kind: item.kind, metadata: item.metadata, spec: item.spec },
        content: item,
      },
      { templates, defaults },
    );
    issues.push(...docIssues.filter((i) => i.severity === "error"));
  }

  // Cross-document checks run on the effective set so duplicate-sibling-title
  // and parent matrix see defaulted values.
  const effectiveSet = set.map((i) => applyDefaults(i, defaults));
  const wsIssues = validateWorkspace(effectiveSet).issues;
  issues.push(...wsIssues.filter((i) => i.severity === "error"));

  // Push-specific checks.
  for (const item of set) {
    // Existing items must have a cached revision baseline (spec §7).
    if (item.metadata.adoId !== undefined) {
      const cached = getCached(deps.db, item.metadata.localId);
      if (!cached || cached.lastKnownRev === undefined) {
        issues.push({
          severity: "error",
          code: "missing_cached_revision",
          message: `${item.kind} '${item.metadata.localId}' (ADO #${item.metadata.adoId}) has no pull baseline — pull this item before pushing`,
          yamlPath: item.yamlPath,
          yamlDocumentIndex: item.yamlDocumentIndex,
          localId: item.metadata.localId,
        });
      }
    }
    if (!WORK_ITEM_KINDS_REQUIRING_PARENT.includes(item.kind)) continue;
    const parent = item.spec.parent;
    if (!parent || parent.adoId === undefined) {
      // Warn only — push proceeds and creates the item orphaned in ADO.
      // executeCreate omits the Hierarchy-Reverse relation when no parent
      // ADO ID is resolvable; the YAML keeps its localId pointer so a later
      // pull/push can reattach the hierarchy.
      issues.push({
        severity: "warning",
        code: "missing_parent_ado_id",
        message: `${item.kind} '${item.metadata.localId}' has no parent ADO ID — will be created orphaned in ADO; push the parent and re-link later`,
        yamlPath: item.yamlPath,
        yamlDocumentIndex: item.yamlDocumentIndex,
        localId: item.metadata.localId,
      });
    } else {
      const allowed = PARENT_MATRIX[item.kind];
      // Validate parent kind via cache (parent might not be in the push set).
      const parentRow = parent.adoId !== undefined ? getCachedByAdoId(deps.db, parent.adoId) : undefined;
      if (parentRow && !allowed.includes(parentRow.workItemType)) {
        issues.push({
          severity: "error",
          code: "invalid_parent_type",
          message: `${item.kind} '${item.metadata.localId}' has parent type ${parentRow.workItemType} — allowed: ${allowed.join(", ")}`,
          yamlPath: item.yamlPath,
          yamlDocumentIndex: item.yamlDocumentIndex,
          localId: item.metadata.localId,
        });
      }
    }
  }
  return issues;
}

function deriveTemplateDir(deps: SyncEngineDeps): string | null {
  // Honor an explicit templateDir from the routes; fall back to the
  // conventional <workspaceDir>/templates location.
  if (deps.templateDir) return existsSync(deps.templateDir) ? deps.templateDir : null;
  const candidate = resolve(deps.workspaceDir, "templates");
  return existsSync(candidate) ? candidate : null;
}

function loadDeps(deps: SyncEngineDeps): ReturnType<typeof loadTemplates> {
  const templateRoot = deriveTemplateDir(deps);
  if (!templateRoot) return { templates: {}, issues: [] };
  return loadTemplates(templateRoot);
}

function loadDefaults(deps: SyncEngineDeps): WorkItemDefaults | undefined {
  return loadDeps(deps).defaults;
}

async function executeCreate(
  deps: SyncEngineDeps,
  step: PushPlanItem,
  parentLocal: LocalWorkItem,
): Promise<ItemOperationResult> {
  const { local } = step;
  const defaults = loadDefaults(deps);
  const effective = applyDefaults(local, defaults);
  const parentAdoId = local.spec.parent?.adoId ?? parentLocal.metadata.adoId;
  // No parent ADO ID? Create the work item without a Hierarchy-Reverse
  // relation — it lands orphaned in ADO. The validator already warned via
  // /api/validate, and the YAML's spec.parent.localId pointer survives so a
  // future push (once the parent has an ADO ID) can re-link the hierarchy.
  const parentUrl = parentAdoId ? workItemUrl(deps.client.organization, parentAdoId) : undefined;
  const patch = buildCreatePatch({ item: effective, parentUrl });
  let created: AdoWorkItem;
  try {
    const adoTypeName = adoTypeNameForKind(local.kind);
    created = await deps.client.patchJson<AdoWorkItem>(
      `wit/workitems/$${encodeURIComponent(adoTypeName)}`,
      patch,
    );
  } catch (err) {
    return {
      action: "create",
      status: "failed",
      errorCode: err instanceof AdoError ? `ado_${err.status}` : "ado_create_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId: local.metadata.localId,
      yamlPath: local.yamlPath,
      yamlDocumentIndex: local.yamlDocumentIndex,
    };
  }

  // Update the YAML file with the new metadata.adoId and persist baseline.
  const updated: LocalWorkItem = {
    ...local,
    metadata: { ...local.metadata, adoId: created.id },
  };
  writeDocument(local.yamlPath, local.yamlDocumentIndex, updated);
  const effectiveUpdated = applyDefaults(updated, defaults);
  upsertWorkItemCache(deps.db, {
    localId: updated.metadata.localId,
    adoId: created.id,
    workItemType: updated.kind,
    yamlPath: updated.yamlPath,
    yamlDocumentIndex: updated.yamlDocumentIndex,
    parentLocalId: updated.spec.parent?.localId,
    parentAdoId: updated.spec.parent?.adoId,
    syncStatus: "synced",
  });
  updateAcceptedBaseline(deps.db, {
    localId: updated.metadata.localId,
    adoId: created.id,
    rev: created.rev,
    fieldHash: fieldHash(effectiveUpdated),
    relationHash: relationHash(effectiveUpdated),
    syncStatus: "synced",
  });
  return {
    action: "create",
    status: "success",
    localId: updated.metadata.localId,
    adoId: created.id,
    workItemType: updated.kind,
    yamlPath: updated.yamlPath,
    yamlDocumentIndex: updated.yamlDocumentIndex,
    afterRev: created.rev,
    syncStatus: "synced",
  };
}

async function executeUpdate(
  deps: SyncEngineDeps,
  step: PushPlanItem,
  remote: AdoWorkItem,
): Promise<ItemOperationResult> {
  const { local, cached } = step;
  if (!cached || cached.lastKnownRev === undefined) {
    return {
      action: "update",
      status: "blocked",
      errorCode: "missing_cached_revision",
      errorMessage: `'${local.metadata.localId}' has no pull baseline — pull this item before pushing`,
      localId: local.metadata.localId,
    };
  }

  const defaults = loadDefaults(deps);
  const effective = applyDefaults(local, defaults);
  const newParentUrl = step.isReparent && local.spec.parent?.adoId
    ? workItemUrl(deps.client.organization, local.spec.parent.adoId)
    : undefined;

  const patch = buildUpdatePatch({
    item: effective,
    cachedRev: cached.lastKnownRev,
    remote,
    newParentUrl,
  });
  let updated: AdoWorkItem;
  try {
    updated = await deps.client.patchJson<AdoWorkItem>(
      `wit/workitems/${remote.id}`,
      patch,
    );
  } catch (err) {
    return {
      action: "update",
      status: "failed",
      errorCode: err instanceof AdoError ? `ado_${err.status}` : "ado_update_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      localId: local.metadata.localId,
      adoId: remote.id,
      cachedRev: cached.lastKnownRev,
      remoteRev: remote.rev,
    };
  }
  upsertWorkItemCache(deps.db, {
    localId: local.metadata.localId,
    adoId: remote.id,
    workItemType: local.kind,
    yamlPath: local.yamlPath,
    yamlDocumentIndex: local.yamlDocumentIndex,
    parentLocalId: local.spec.parent?.localId,
    parentAdoId: local.spec.parent?.adoId,
    syncStatus: "synced",
  });
  updateAcceptedBaseline(deps.db, {
    localId: local.metadata.localId,
    adoId: remote.id,
    rev: updated.rev,
    fieldHash: fieldHash(effective),
    relationHash: relationHash(effective),
    syncStatus: "synced",
  });
  return {
    action: "update",
    status: "success",
    localId: local.metadata.localId,
    adoId: remote.id,
    workItemType: local.kind,
    yamlPath: local.yamlPath,
    yamlDocumentIndex: local.yamlDocumentIndex,
    beforeRev: cached.lastKnownRev,
    afterRev: updated.rev,
    cachedRev: cached.lastKnownRev,
    remoteRev: updated.rev,
    syncStatus: "synced",
  };
}

function adoTypeNameForKind(kind: import("../shared/types.ts").WorkItemType): string {
  switch (kind) {
    case "PBI":
      return "Product Backlog Item";
    default:
      return kind;
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
  const rawCached = getCachedByAdoId(deps.db, remote.id);
  // If the cache entry exists but the YAML file was deleted, treat it as absent
  // so the create-missing path re-creates it rather than skipping.
  const cached = rawCached && existsSync(rawCached.yamlPath) ? rawCached : null;
  const defaults = loadDefaults(deps);

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

    // Effective item is used for hashes; YAML on disk omits values that
    // already match the applicable defaults.
    const effective = applyDefaults(local, defaults);
    const trimmed = omitDefaults(local, defaults);
    trimmed.yamlPath = targetPath;
    const docIndex = appendDocument(targetPath, trimmed);
    local.yamlDocumentIndex = docIndex;
    trimmed.yamlDocumentIndex = docIndex;

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
      fieldHash: fieldHash(effective),
      relationHash: relationHash(effective),
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
  const defaults = loadDefaults(deps);
  const effective = applyDefaults(local, defaults);
  const trimmed = omitDefaults(local, defaults);

  try {
    writeDocument(cached.yamlPath, cached.yamlDocumentIndex, trimmed);
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
    fieldHash: fieldHash(effective),
    relationHash: relationHash(effective),
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
