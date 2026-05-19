import type { Database } from "bun:sqlite";
import { writeAuditEntry, type AuditAction } from "./audit.ts";
import type { ItemOperationResult } from "../shared/types.ts";

export type SyncAuditDeps = {
  db: Database;
  pat?: string;
};

export function auditFor(
  deps: SyncAuditDeps,
  operationId: string,
  result: ItemOperationResult,
  request: unknown,
): void {
  const action: AuditAction =
    result.status === "blocked" || result.status === "requires_confirmation"
      ? "block"
      : result.status === "failed"
        ? "fail"
        : result.action === "create"
          ? "create"
          : result.action === "update"
            ? "update"
            : result.action === "skip"
              ? "skip"
              : "pull";
  writeAuditEntry(
    deps.db,
    {
      operationId,
      action,
      localId: result.localId,
      adoId: result.adoId,
      workItemType: result.workItemType,
      yamlPath: result.yamlPath,
      beforeRev: result.beforeRev ?? result.cachedRev,
      afterRev: result.afterRev ?? result.remoteRev,
      success: result.status === "success",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      requestSummary: redactRequestForAudit(request),
      responseSummary: {
        action: result.action,
        status: result.status,
        confirmationRequired: result.confirmationRequired,
        syncStatus: result.syncStatus,
        cachedRev: result.cachedRev,
        remoteRev: result.remoteRev,
      },
    },
    { pat: deps.pat },
  );
}

function redactRequestForAudit(request: unknown): unknown {
  const r = request as Record<string, unknown>;
  return {
    parent: r.parent,
    selector: r.selector,
    confirmationCount: Array.isArray(r.confirmations) ? r.confirmations.length : undefined,
    confirmation: "confirmation" in r ? Boolean(r.confirmation) : undefined,
    childLocalIds: r.childLocalIds,
    confirmedParentChanges: r.confirmedParentChanges,
    confirmedParentChange: r.confirmedParentChange,
  };
}
