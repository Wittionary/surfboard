// Pure rendering helpers for the local view. Phase 2 covers parent hero, child
// grid rows, and footer summary. Phase 3+ will add pull/push action affordances
// and status pills for remote-aware sync states.

import type { WorkItemView, WorkspaceStatusResponse, ParentViewResponse } from "../server/routes.ts";
import type {
  HealthReport,
  ItemOperationResult,
  OperationResult,
  PullOverwriteConfirmation,
  ValidationIssue,
} from "../shared/types.ts";

export function escape(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function statusPillClass(severity: "ok" | "warn" | "fail"): string {
  return `status-pill status-pill--${severity}`;
}

export function validationLabel(issues: readonly ValidationIssue[]): { text: string; severity: "ok" | "warn" | "fail" } {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (errors > 0) return { text: `${errors} error${errors === 1 ? "" : "s"}`, severity: "fail" };
  if (warnings > 0) return { text: `${warnings} warn${warnings === 1 ? "" : "s"}`, severity: "warn" };
  return { text: "Valid", severity: "ok" };
}

export function renderParentHero(view: WorkItemView | null): {
  type: string;
  title: string;
  adoId: string;
  state: string;
  syncStatus: string;
  yamlPath: string;
} {
  if (!view) {
    return { type: "—", title: "No parent selected", adoId: "—", state: "—", syncStatus: "—", yamlPath: "—" };
  }
  return {
    type: view.workItemType,
    title: view.title ?? "(untitled)",
    adoId: view.adoId !== undefined ? String(view.adoId) : "—",
    state: view.state ?? "—",
    syncStatus: deriveDisplayStatus(view),
    yamlPath: view.yamlPath,
  };
}

export function renderChildRows(children: readonly WorkItemView[]): string {
  if (children.length === 0) {
    return `<tr class="child-grid__placeholder"><td colspan="8">No children loaded.</td></tr>`;
  }
  return children
    .map((c) => {
      const v = validationLabel(c.validationIssues);
      const titleAttr = escape(c.title ?? "");
      const issuesAttr = escape(c.validationIssues.map((i) => `${i.code}: ${i.message}`).join(" | "));
      return `<tr data-local-id="${escape(c.localId)}">
  <td><span class="${statusPillClass(v.severity)}" title="${issuesAttr}">${escape(v.text)}</span></td>
  <td>${escape(c.workItemType)}</td>
  <td title="${titleAttr}">${escape(c.title ?? "(untitled)")}</td>
  <td>${escape(c.localId)}</td>
  <td>${escape(c.adoId !== undefined ? String(c.adoId) : "—")}</td>
  <td>${escape(c.state ?? "—")}</td>
  <td>${escape(c.adoId !== undefined ? "—" : "(local)")}</td>
  <td><button type="button" data-action="row-validate" data-local-id="${escape(c.localId)}">Validate</button></td>
</tr>`;
    })
    .join("\n");
}

export function renderFooter(status: WorkspaceStatusResponse | null, healthSummary: string | null): {
  lastSync: string;
  health: string;
  version: string;
} {
  return {
    lastSync: status ? `Refreshed: ${formatTime(status.refreshedAt)} (${status.documentCount} docs, ${status.validItemCount} valid)` : "Refreshed: never",
    health: healthSummary ? `Health: ${healthSummary}` : "Health: —",
    version: "Version: 0.1.0",
  };
}

export type HealthPanelRow = {
  label: string;
  status: "ok" | "degraded" | "failed" | "disabled" | "unknown";
  detail: string;
};

export function renderHealthPanel(report: HealthReport | null): HealthPanelRow[] {
  if (!report) return [{ label: "Health", status: "unknown", detail: "loading" }];
  const rows: HealthPanelRow[] = [
    { label: "App", status: report.app.status, detail: `version ${report.app.version}` },
    { label: "Config", status: report.config.status, detail: report.config.issues.join(", ") || "ok" },
    { label: "SQLite", status: report.sqlite.status, detail: report.sqlite.error ?? report.sqlite.path ?? "ok" },
    { label: "Workspace", status: report.workspace.status, detail: report.workspace.path ?? "—" },
    { label: "Templates", status: report.templates.status, detail: report.templates.path ?? "—" },
  ];
  if (report.ado) {
    rows.push({
      label: "ADO Auth",
      status: report.ado.auth,
      detail: report.ado.lastError ?? "ok",
    });
    rows.push({ label: "ADO Project", status: report.ado.project, detail: "" });
  }
  if (report.watcher) {
    rows.push({
      label: "Watcher",
      status: report.watcher.status,
      detail: report.watcher.error ?? "ok",
    });
  }
  if (report.webhook) {
    rows.push({
      label: "Webhook",
      status: report.webhook.status,
      detail: report.webhook.lastEventAt ?? "no events",
    });
  }
  if (report.lastSync) {
    rows.push({
      label: "Last sync",
      status: report.lastSync.failure > 0 ? "failed" : report.lastSync.blocked > 0 ? "degraded" : "ok",
      detail: `at ${report.lastSync.at ?? "—"} • ok=${report.lastSync.success} fail=${report.lastSync.failure} blocked=${report.lastSync.blocked}`,
    });
  }
  if (report.validation) {
    rows.push({
      label: "Validation",
      status: report.validation.lastIssueCount > 0 ? "degraded" : "ok",
      detail: `${report.validation.lastIssueCount} issue${report.validation.lastIssueCount === 1 ? "" : "s"}`,
    });
  }
  return rows;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleTimeString()}`;
  } catch {
    return iso;
  }
}

function deriveDisplayStatus(view: WorkItemView): string {
  const errors = view.validationIssues.filter((i) => i.severity === "error").length;
  if (errors > 0) return "validation_failed";
  if (view.adoId === undefined) return "local_only";
  return "synced";
}

export type LocalViewModel = {
  parent: WorkItemView | null;
  children: WorkItemView[];
};

export function buildLocalViewModel(parent: ParentViewResponse | null): LocalViewModel {
  return {
    parent: parent?.parent ?? null,
    children: parent?.children ?? [],
  };
}

/**
 * Extracts the items from a pull `OperationResult` that need user confirmation
 * to overwrite local YAML. The frontend renders a popup per spec §8.6 with
 * cancel as the default action.
 */
export function extractOverwriteRequests(
  result: OperationResult,
): Array<{ item: ItemOperationResult; confirmation: PullOverwriteConfirmation }> {
  return result.items
    .filter((item) => item.status === "requires_confirmation" && item.confirmationRequired === "overwrite_yaml")
    .filter((item) => item.adoId !== undefined && item.yamlPath !== undefined && item.remoteRev !== undefined)
    .map((item) => ({
      item,
      confirmation: {
        adoId: item.adoId as number,
        yamlPath: item.yamlPath as string,
        yamlDocumentIndex: item.yamlDocumentIndex ?? 0,
        remoteRev: item.remoteRev as number,
        confirmed: true,
        ...(item.localId ? { localId: item.localId } : {}),
      },
    }));
}

export type ConfirmPopupModel = {
  title: string;
  workItemType: string;
  localId: string;
  adoId: string;
  yamlPath: string;
  cachedRev: string;
  remoteRev: string;
};

export function buildConfirmPopup(item: ItemOperationResult): ConfirmPopupModel {
  return {
    title: `Overwrite local YAML?`,
    workItemType: item.workItemType ?? "",
    localId: item.localId ?? "(unknown)",
    adoId: item.adoId !== undefined ? String(item.adoId) : "—",
    yamlPath: item.yamlPath ?? "",
    cachedRev: item.cachedRev !== undefined ? String(item.cachedRev) : "—",
    remoteRev: item.remoteRev !== undefined ? String(item.remoteRev) : "—",
  };
}

/**
 * Maps spec §8.7 keyboard combinations to action names. Pure function so
 * tests don't need a real KeyboardEvent — any object with key/altKey/shiftKey
 * works as input.
 */
export type HotkeyEventLike = { key: string; altKey: boolean; shiftKey: boolean };

export function matchHotkey(ev: HotkeyEventLike): string | null {
  if (!ev.altKey || !ev.shiftKey) return null;
  switch (ev.key.toUpperCase()) {
    case "U":
      return "push-all";
    case "I":
      return "pull-all";
    case "J":
      return "push-selected";
    case "K":
      return "pull-selected";
    case "V":
      return "refresh";
    default:
      return null;
  }
}
