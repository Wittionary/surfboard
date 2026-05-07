// Holds the most recent workspace scan so routes can serve status and view
// queries without re-scanning every request.

import type { Database } from "bun:sqlite";
import { indexWorkspace, scanWorkspace, type WorkspaceScanResult } from "./workspace.ts";

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

export class WorkspaceState {
  private snapshot: WorkspaceStateSnapshot | null = null;

  constructor(private readonly deps: WorkspaceStateDeps) {}

  /** Re-scan and re-index. Call on workspace refresh. */
  refresh(options: { pruneOrphans?: boolean } = {}): WorkspaceStateSnapshot {
    const scan = scanWorkspace({
      workspaceDir: this.deps.workspaceDir,
      templateDir: this.deps.templateDir,
    });
    indexWorkspace(this.deps.db, scan, options);
    this.snapshot = {
      scan,
      refreshedAt: new Date().toISOString(),
      templateDir: this.deps.templateDir,
    };
    return this.snapshot;
  }

  /** Returns the current snapshot, refreshing once on first access. */
  current(): WorkspaceStateSnapshot {
    return this.snapshot ?? this.refresh();
  }
}
