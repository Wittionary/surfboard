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
  ValidationIssueCode,
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

export function renderParentHero(view: WorkItemView | null, workspaceDir?: string | null): {
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
  const displayPath =
    workspaceDir && view.yamlPath.startsWith(workspaceDir)
      ? view.yamlPath.slice(workspaceDir.length).replace(/^[/\\]/, "")
      : view.yamlPath;
  return {
    type: view.workItemType,
    title: view.title ?? "(untitled)",
    adoId: view.adoId !== undefined ? String(view.adoId) : "—",
    state: view.state ?? "—",
    syncStatus: deriveDisplayStatus(view),
    yamlPath: displayPath,
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
export function howToFix(code: ValidationIssueCode): string {
  switch (code) {
    case "missing_required_field":   return "Provide a non-empty value for this required field.";
    case "unknown_field":            return "Remove this field, or add it to your template's optionalFields. Fields returned by ADO that aren't listed in the template generate this warning.";
    case "invalid_field_type":       return "Change the value to match the expected type defined in your template's fieldRules.";
    case "invalid_enum_value":       return "Use one of the allowed values defined in your template's fieldRules for this field.";
    case "invalid_kind":             return "Set kind to one of: Epic, Feature, PBI, Enabler, Task.";
    case "invalid_api_version":      return "Set apiVersion to surfboard.ado/v1.";
    case "yaml_invalid":             return "Fix the YAML structure — check indentation, colons, and the document envelope (apiVersion, kind, metadata, spec).";
    case "unknown_top_level_key":    return "Remove the unrecognized top-level key. Allowed keys are: apiVersion, kind, metadata, spec.";
    case "tags_not_allowed":         return "Remove spec.tags — the template for this work item type does not allow tags.";
    case "missing_parent":           return "Add spec.parent with localId or adoId pointing to the parent work item.";
    case "invalid_parent_type":      return "The parent's work item type is not allowed here. Hierarchy: Feature→Epic, PBI/Enabler→Feature, Task→PBI or Enabler.";
    case "missing_parent_ado_id":    return "The parent exists locally but has no ADO ID. Push the parent to ADO first, then push this item.";
    case "duplicate_local_id":       return "Change metadata.localId to a value that is unique across the workspace.";
    case "duplicate_sibling_title":  return "Change System.Title — a sibling item under the same parent already has this normalized title.";
    case "missing_cached_revision":  return "Pull this item to establish a local baseline before pushing.";
    case "remote_revision_changed":  return "The remote item changed since the last pull. Pull first to review the change, then push.";
    case "remote_deleted":           return "The remote work item was deleted. Remove this YAML entry if it is no longer needed.";
    case "yaml_changed_during_push": return "The YAML file was modified during the push. Retry.";
    case "template_missing":         return "Create a schema template file for this work item type in your ADO_TEMPLATE_DIR.";
    case "template_duplicate":       return "Remove the duplicate template — only one template per work item type is allowed.";
    case "template_malformed":       return "Fix the YAML syntax in the template file.";
  }
}

export function renderValidationDetails(issues: readonly ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length === 0) {
    return `<li class="validation-issue"><div class="validation-issue__message">No errors found.</div></li>`;
  }
  return errors
    .map((issue) => {
      const parts: string[] = [];
      if (issue.line !== undefined) parts.push(`Line ${issue.line}`);
      if (issue.field) parts.push(issue.field);
      const loc = parts.join(" · ");
      const fix = howToFix(issue.code);
      return `<li class="validation-issue">
  ${loc ? `<div class="validation-issue__loc">${escape(loc)}</div>` : ""}
  <div class="validation-issue__message">${escape(issue.message)}</div>
  ${fix ? `<div class="validation-issue__fix">→ ${escape(fix)}</div>` : ""}
</li>`;
    })
    .join("\n");
}

export type LastOpSummary = {
  text: string;
  status: "ok" | "warn" | "fail";
};

export function renderLastOpSummary(op: {
  type: "pull" | "push";
  result: OperationResult;
  at: Date;
}): LastOpSummary {
  const { type, result, at } = op;
  const s = result.summary;
  const label = type === "pull" ? "Pull" : "Push";
  const time = formatTime(at.toISOString());

  let detail: string;
  if (result.status === "success" || result.status === "partial_failure") {
    if (type === "pull") {
      detail = s.pulled > 0 ? `${s.pulled} pulled` : "up to date";
    } else {
      const n = s.created + s.updated;
      detail = n > 0 ? `${n} pushed` : "no changes";
    }
    const extra: string[] = [];
    if (s.failed > 0) extra.push(`${s.failed} failed`);
    if (s.blocked > 0) extra.push(`${s.blocked} blocked`);
    if (extra.length > 0) detail += `, ${extra.join(", ")}`;
  } else {
    detail = result.status;
  }

  const status: "ok" | "warn" | "fail" =
    result.status === "success" ? "ok" :
    result.status === "partial_failure" || result.status === "blocked" ? "warn" : "fail";

  return { text: `${label} · ${detail} · ${time}`, status };
}

const SHORT_HINTS: Record<string, string> = {
  parent_fetch_failed:          "ADO fetch failed",
  children_fetch_failed:        "ADO fetch failed",
  fetch_failed:                 "ADO fetch failed",
  remote_fetch_failed:          "ADO fetch failed",
  remote_deleted:               "Deleted in ADO",
  unknown_parent_local_id:      "Parent not found",
  missing_cached_revision:      "Pull required",
  remote_revision_changed:      "Revision drift — pull first",
  yaml_changed_during_push:     "YAML changed — retry",
  create_parent_not_supported:  "Parent creation out of scope",
  missing_parent_ado_id:        "Push parent first",
  duplicate_local_id:           "Duplicate local ID",
  duplicate_sibling_title:      "Duplicate sibling title",
  missing_required_field:       "Required field missing",
  yaml_invalid:                 "Invalid YAML",
};

const LONG_HINTS: Record<string, string> = {
  parent_fetch_failed:          "Check your ADO connection and PAT credentials, then retry.",
  children_fetch_failed:        "Check your ADO connection and PAT credentials, then retry.",
  fetch_failed:                 "Check your ADO connection and PAT credentials, then retry.",
  remote_fetch_failed:          "Check your ADO connection and PAT credentials, then retry.",
  remote_deleted:               "The remote work item was deleted. Remove this YAML entry if it is no longer needed.",
  unknown_parent_local_id:      "The parent selector didn't match any local item. Check that metadata.localId is correct in the YAML.",
  missing_cached_revision:      "Pull this item first to establish a baseline revision before pushing.",
  remote_revision_changed:      "The remote item changed since the last pull. Pull to review the change, then push.",
  yaml_changed_during_push:     "The YAML file was modified during the push. Save your changes and retry.",
  create_parent_not_supported:  "Parent creation is out of scope for MVP. Import the parent from ADO first using the Import field.",
};

function shortHint(code: string | undefined): string | null {
  if (!code) return null;
  return SHORT_HINTS[code] ?? null;
}

function longHint(code: string | undefined): string | null {
  if (!code) return null;
  return LONG_HINTS[code] ?? howToFix(code as ValidationIssueCode) ?? null;
}

/** Returns a one-line tooltip for a non-successful last operation. */
export function renderLastOpTooltip(result: OperationResult): string {
  const problems = result.items.filter(
    (i) => i.status === "failed" || i.status === "blocked",
  );
  if (problems.length === 1) {
    const p = problems[0]!;
    return shortHint(p.errorCode) ?? p.errorMessage?.slice(0, 60) ?? result.status;
  }
  if (problems.length > 1) {
    return `${problems.length} items ${result.status === "failed" ? "failed" : "blocked"}`;
  }
  return result.status === "blocked" ? "Operation blocked" : "Operation failed";
}

export type LastOpModalContent = { title: string; body: string };

/** Returns the title and inner list HTML for the last-op detail modal. */
export function renderLastOpModal(op: {
  type: "pull" | "push";
  result: OperationResult;
}): LastOpModalContent {
  const label = op.type === "pull" ? "Pull" : "Push";
  const statusLabel: Record<string, string> = {
    partial_failure: "partial failure",
    blocked: "blocked",
    failed: "failed",
    success: "succeeded",
  };
  const title = `${label} ${statusLabel[op.result.status] ?? op.result.status}`;

  const problems = op.result.items.filter(
    (i) => i.status === "failed" || i.status === "blocked",
  );

  if (problems.length === 0) {
    return {
      title,
      body: `<li class="validation-issue"><div class="validation-issue__message">${escape(op.result.status)}</div></li>`,
    };
  }

  const body = problems
    .map((item) => {
      const idParts: string[] = [];
      if (item.workItemType) idParts.push(item.workItemType);
      if (item.localId) idParts.push(item.localId);
      if (item.adoId !== undefined) idParts.push(`ADO #${item.adoId}`);
      const idStr = idParts.join(" · ");
      const message = item.errorMessage ?? item.errorCode ?? item.status;
      const fix = longHint(item.errorCode);
      return `<li class="validation-issue">
  ${idStr ? `<div class="validation-issue__loc">${escape(idStr)}</div>` : ""}
  <div class="validation-issue__message">${escape(message)}</div>
  ${fix ? `<div class="validation-issue__fix">→ ${escape(fix)}</div>` : ""}
</li>`;
    })
    .join("\n");

  return { title, body };
}

export type HotkeyEventLike = { key: string; altKey: boolean; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean };

export function matchHotkey(ev: HotkeyEventLike): string | null {
  if (ev.key === "n" && !ev.altKey && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) return "new-child";
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
