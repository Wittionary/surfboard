// Workspace scanning and cache indexing per spec §4 and §5. Reads YAML
// documents from `ADO_WORKSPACE_DIR`, validates each against templates, and
// upserts metadata-only rows into `work_item_cache`. The actual field content
// stays in YAML.

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { parseYamlFile, scanWorkspaceFiles } from "./yamlStore.ts";
import type { ParsedDocument } from "./yamlStore.ts";
import { loadTemplates, type TemplateLoadResult } from "./templateStore.ts";
import { validateDocument, validateWorkspace } from "./validator.ts";
import { upsertWorkItemCache, getAllCached, getCached, deleteCacheEntry } from "./db.ts";
import { fieldHash, relationHash, safeFileHash } from "./hash.ts";
import { applyDefaults } from "./defaults.ts";
import type { ValidationIssue, WorkItemType, SyncStatus, LocalWorkItem } from "../shared/types.ts";

export type WorkspaceDocument = {
  doc: ParsedDocument;
  /** Pulled out for convenience when the document parses to a work item. */
  item?: LocalWorkItem;
  issues: ValidationIssue[];
};

export type WorkspaceScanResult = {
  workspaceDir: string;
  templates: TemplateLoadResult;
  documents: WorkspaceDocument[];
  /** Aggregated issues across templates and per-document validation. */
  issues: ValidationIssue[];
};

export type WorkspaceScanOptions = {
  workspaceDir: string;
  templateDir: string;
};

export function scanWorkspace(options: WorkspaceScanOptions): WorkspaceScanResult {
  const templates = loadTemplates(options.templateDir);
  const issues: ValidationIssue[] = [...templates.issues];

  if (!options.workspaceDir || !existsSync(options.workspaceDir)) {
    return {
      workspaceDir: options.workspaceDir,
      templates,
      documents: [],
      issues,
    };
  }

  const parsed = discoverWorkspaceDocuments(options);
  const validated = validateWorkspaceDocuments(parsed, templates);
  issues.push(...validated.issues);

  return {
    workspaceDir: options.workspaceDir,
    templates,
    documents: validated.documents,
    issues,
  };
}

export function discoverWorkspaceDocuments(options: WorkspaceScanOptions): ParsedDocument[] {
  if (!options.workspaceDir || !existsSync(options.workspaceDir)) return [];
  const documents: ParsedDocument[] = [];
  const files = scanWorkspaceFiles(options.workspaceDir, { excludeDir: options.templateDir });
  for (const file of files) {
    documents.push(...parseYamlFile(file.path));
  }
  return documents;
}

export function validateWorkspaceDocuments(
  docs: readonly ParsedDocument[],
  templates: TemplateLoadResult,
): { documents: WorkspaceDocument[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const documents: WorkspaceDocument[] = [];

  for (const doc of docs) {
    const docIssues = validateDocument(doc, { templates, defaults: templates.defaults });
    documents.push({ doc, item: doc.content, issues: docIssues });
    issues.push(...docIssues);
  }

  // Cross-document checks: parent matrix, missing parent, duplicate localId,
  // duplicate sibling titles. Effective items (with defaults applied) are used
  // so checks like duplicate sibling titles see the effective Title.
  const items = documents
    .map((d) => d.item)
    .filter((i): i is LocalWorkItem => i !== undefined)
    .map((i) => applyDefaults(i, templates.defaults));
  const workspaceIssues = validateWorkspace(items).issues;

  // Attribute workspace-level issues back to their documents so callers can
  // group results by file/document.
  for (const issue of workspaceIssues) {
    const target = documents.find((d) =>
      d.doc.path === issue.yamlPath && d.doc.documentIndex === issue.yamlDocumentIndex,
    ) ?? (issue.localId
      ? documents.find((d) => d.item?.metadata.localId === issue.localId)
      : undefined);
    if (target) target.issues.push(issue);
  }
  issues.push(...workspaceIssues);

  return { documents, issues };
}

export type IndexWorkspaceOptions = {
  /** When true, removes cache entries whose local_id no longer appears in the workspace. */
  pruneOrphans?: boolean;
};

/**
 * Indexes the workspace into the cache. Returns the number of rows upserted
 * and pruned. Only valid (well-shaped) documents are upserted; invalid ones
 * still appear in the scan result so the UI can show their issues.
 */
export function indexWorkspaceCache(
  db: Database,
  scan: WorkspaceScanResult,
  options: IndexWorkspaceOptions = {},
): { upserted: number; pruned: number } {
  let upserted = 0;
  const seenLocalIds = new Set<string>();

  for (const wd of scan.documents) {
    const item = wd.item;
    if (!item) continue;
    seenLocalIds.add(item.metadata.localId);
    const fileHash = safeFileHash(item.yamlPath);
    const status = deriveSyncStatus(wd, db, scan.templates.defaults);
    upsertWorkItemCache(db, {
      localId: item.metadata.localId,
      adoId: item.metadata.adoId,
      workItemType: item.kind as WorkItemType,
      yamlPath: item.yamlPath,
      yamlDocumentIndex: item.yamlDocumentIndex,
      parentLocalId: item.spec.parent?.localId,
      parentAdoId: item.spec.parent?.adoId,
      localFileHash: fileHash,
      syncStatus: status,
    });
    upserted += 1;
  }

  let pruned = 0;
  if (options.pruneOrphans) {
    for (const cached of getAllCached(db)) {
      if (!seenLocalIds.has(cached.localId)) {
        deleteCacheEntry(db, cached.localId);
        pruned += 1;
      }
    }
  }

  return { upserted, pruned };
}

export const indexWorkspace = indexWorkspaceCache;

function deriveSyncStatus(
  wd: WorkspaceDocument,
  db: Database,
  defaults: TemplateLoadResult["defaults"],
): SyncStatus {
  // Phase 2 derives only local statuses. Pull/push add remote_changed,
  // conflict_blocked, etc. in later phases.
  if (wd.issues.some((i) => i.severity === "error")) return "validation_failed";
  const item = wd.item;
  if (!item) return "validation_failed";

  // No cached baseline → never been pulled or pushed → local-only.
  const cached = getCached(db, item.metadata.localId);
  if (!cached || cached.lastKnownFieldHash === undefined) return "local_only";

  const effective = applyDefaults(item, defaults);
  const currentField = fieldHash(effective);
  const currentRelation = relationHash(effective);
  if (
    currentField === cached.lastKnownFieldHash &&
    currentRelation === cached.lastKnownRelationHash
  ) {
    return "synced";
  }
  return "local_changed";
}
