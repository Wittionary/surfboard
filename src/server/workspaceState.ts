// Holds the most recent workspace scan so routes can serve status and view
// queries without re-scanning every request.

import type { Database } from "bun:sqlite";
import { childLog } from "./logger.ts";
import { indexWorkspace, scanWorkspace, type WorkspaceScanResult } from "./workspace.ts";

const log = childLog("workspace");

export type WorkspaceStateDeps = {
  workspaceDir: string;
  templateDir: string;
  db: Database;
};

export type WorkspaceStateSnapshot = {
  scan: WorkspaceScanResult;
  refreshedAt: string;
  templateDir: string;
};

export type LastSyncSummary = {
  at: string;
  success: number;
  failure: number;
  blocked: number;
};

export class WorkspaceState {
  private snapshot: WorkspaceStateSnapshot | null = null;
  private lastSyncSummary: LastSyncSummary | null = null;

  constructor(private readonly deps: WorkspaceStateDeps) {}

  recordLastSync(summary: { success: number; failure: number; blocked: number }): void {
    this.lastSyncSummary = { at: new Date().toISOString(), ...summary };
  }

  getLastSync(): LastSyncSummary | null {
    return this.lastSyncSummary;
  }

  /** Re-scan and re-index. Call on workspace refresh. */
  refresh(options: { pruneOrphans?: boolean } = {}): WorkspaceStateSnapshot {
    const scan = scanWorkspace({
      workspaceDir: this.deps.workspaceDir,
      templateDir: this.deps.templateDir,
    });
    const { upserted, pruned } = indexWorkspace(this.deps.db, scan, options);
    this.snapshot = {
      scan,
      refreshedAt: new Date().toISOString(),
      templateDir: this.deps.templateDir,
    };

    const errors = scan.issues.filter((i) => i.severity === "error");
    const warnings = scan.issues.filter((i) => i.severity === "warning");
    log.info(
      {
        workspaceDir: this.deps.workspaceDir,
        docCount: scan.documents.length,
        validCount: scan.documents.filter((d) => d.item).length,
        upserted,
        pruned,
        errorCount: errors.length,
        warnCount: warnings.length,
      },
      "workspace refreshed",
    );

    for (const issue of errors) {
      log.warn(
        {
          code: issue.code,
          severity: issue.severity,
          field: issue.field,
          localId: issue.localId,
          yamlPath: issue.yamlPath,
          yamlDocumentIndex: issue.yamlDocumentIndex,
        },
        issue.message,
      );
    }

    return this.snapshot;
  }

  /** Returns the current snapshot, refreshing once on first access. */
  current(): WorkspaceStateSnapshot {
    return this.snapshot ?? this.refresh();
  }
}
