// Workspace scanning and cache indexing per spec §4 and §5. Reads YAML
// documents from `ADO_WORKSPACE_DIR`, validates each against templates, and
// upserts metadata-only rows into `work_item_cache`. The actual field content
// stays in YAML.

import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { parseYamlFile, scanWorkspaceFiles } from "./yamlStore.ts";
import type { ParsedDocument } from "./yamlStore.ts";
import { loadTemplates, type TemplateLoadResult } from "./templateStore.ts";
import { validateDocument } from "./validator.ts";
import { upsertWorkItemCache, getAllCached, deleteCacheEntry } from "./db.ts";
import { fileSha256 } from "./hash.ts";
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
  const documents: WorkspaceDocument[] = [];

  if (!options.workspaceDir || !existsSync(options.workspaceDir)) {
    return {
      workspaceDir: options.workspaceDir,
      templates,
      documents,
      issues,
    };
  }

  const files = scanWorkspaceFiles(options.workspaceDir, { excludeDir: options.templateDir });
  for (const file of files) {
    const docs = parseYamlFile(file.path);
    for (const doc of docs) {
      const docIssues = validateDocument(doc, { templates });
      documents.push({ doc, item: doc.content, issues: docIssues });
      issues.push(...docIssues);
    }
  }

  return {
    workspaceDir: options.workspaceDir,
    templates,
    documents,
    issues,
  };
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
export function indexWorkspace(
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
    const status = deriveSyncStatus(wd, db);
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

function safeFileHash(path: string): string | undefined {
  try {
    return fileSha256(readFileSync(path));
  } catch {
    return undefined;
  }
}

function deriveSyncStatus(wd: WorkspaceDocument, _db: Database): SyncStatus {
  // Phase 2 derives only local statuses. Pull/push add remote_changed,
  // conflict_blocked, etc. in later phases.
  if (wd.issues.some((i) => i.severity === "error")) return "validation_failed";
  // Without a cached baseline we can't tell synced from local_changed; that
  // logic moves into Task 2.6 once hash baselines exist. For Phase 2.4 we
  // mark as local_only.
  return "local_only";
}
