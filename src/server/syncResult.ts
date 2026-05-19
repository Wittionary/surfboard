import type { ItemOperationResult, OperationResult, OperationSummary } from "../shared/types.ts";

export function emptyOperationSummary(): OperationSummary {
  return { validated: 0, created: 0, updated: 0, pulled: 0, blocked: 0, failed: 0 };
}

export function rollupStatus(s: { failed: number; blocked: number }): OperationResult["status"] {
  if (s.failed > 0 && s.blocked === 0) return "failed";
  if (s.failed > 0 || s.blocked > 0) return "partial_failure";
  return "success";
}

export function tallyPullSummary(
  summary: OperationSummary,
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

export function tallyPushSummary(
  summary: OperationSummary,
  result: ItemOperationResult,
): void {
  if (result.status === "success") {
    if (result.action === "create") summary.created += 1;
    else if (result.action === "update") summary.updated += 1;
  } else if (result.status === "blocked" || result.status === "requires_confirmation") {
    summary.blocked += 1;
  } else if (result.status === "failed") {
    summary.failed += 1;
  }
}

export function summarizeOperationResult(
  result: OperationResult,
): { success: number; failure: number; blocked: number } {
  let success = 0;
  let failure = 0;
  let blocked = 0;
  for (const item of result.items) {
    if (item.status === "success") success += 1;
    else if (item.status === "failed") failure += 1;
    else if (item.status === "blocked" || item.status === "requires_confirmation") blocked += 1;
  }
  return { success, failure, blocked };
}
