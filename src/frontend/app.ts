// Phase 3 frontend: load workspace status, fetch parent view, render hero +
// child grid, and wire pull/refresh actions with the spec §8.6 confirmation
// popup.

import type {
  ParentViewResponse,
  WorkspaceStatusResponse,
} from "../server/routes.ts";
import type {
  HealthReport,
  ItemOperationResult,
  OperationResult,
  PullOverwriteConfirmation,
} from "../shared/types.ts";
import {
  buildConfirmPopup,
  buildLocalViewModel,
  extractOverwriteRequests,
  matchHotkey as matchHotkeyImpl,
  renderChildRows,
  renderFooter,
  renderParentHero,
} from "./render.ts";

/** Re-exported for back-compat with the existing test layout. */
export const matchHotkey = matchHotkeyImpl;

let currentParentLocalId: string | null = null;

async function loadJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function applyParentHero(view: ReturnType<typeof renderParentHero>): void {
  const map: Record<string, string> = {
    type: "kind",
    title: "title",
    adoId: "adoId",
    state: "state",
    syncStatus: "syncStatus",
    yamlPath: "yamlPath",
  };
  for (const [field, value] of Object.entries(view)) {
    const sel = map[field];
    if (!sel) continue;
    const el = document.querySelector<HTMLElement>(`[data-field='${sel}']`);
    if (el) el.textContent = value;
  }
}

function applyChildRows(html: string): void {
  const tbody = document.querySelector("[data-region='children-body']");
  if (tbody) tbody.innerHTML = html;
}

function applyFooter(model: { lastSync: string; health: string; version: string }): void {
  for (const [field, value] of Object.entries(model)) {
    const el = document.querySelector(`[data-field='${field}']`);
    if (el) el.textContent = value;
  }
}

function setBusy(busy: boolean): void {
  document.body.toggleAttribute("data-busy", busy);
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    btn.disabled = busy;
  }
}

async function refresh(): Promise<void> {
  const [status, health] = await Promise.all([
    postJson<WorkspaceStatusResponse>("/api/workspace/refresh", {}),
    loadJson<HealthReport>("/api/health"),
  ]);
  applyFooter(renderFooter(status, health?.app.status ?? null));
  if (currentParentLocalId) await renderParent(currentParentLocalId);
}

async function renderParent(localId: string): Promise<void> {
  currentParentLocalId = localId;
  const parent = await loadJson<ParentViewResponse>(
    `/api/view/parent/${encodeURIComponent(localId)}`,
  );
  const model = buildLocalViewModel(parent);
  applyParentHero(renderParentHero(model.parent));
  applyChildRows(renderChildRows(model.children));
  enableActions(parent !== null);
}

function enableActions(hasParent: boolean): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    if (btn.dataset.action === "refresh") {
      btn.disabled = false;
    } else {
      btn.disabled = !hasParent;
    }
  }
}

export type ConfirmDialog = {
  show: (item: ItemOperationResult) => Promise<boolean>;
};

/**
 * Shows the spec §8.6 popup. Default action is cancel; resolves to true when
 * the user confirms overwrite, false when they cancel or close. Exported and
 * implemented around DOM hooks so tests can swap it for a deterministic
 * stand-in.
 */
export function buildBrowserConfirmDialog(): ConfirmDialog {
  return {
    show: (item) =>
      new Promise<boolean>((resolve) => {
        const modal = document.querySelector<HTMLElement>("[data-region='overwrite-modal']");
        if (!modal) {
          resolve(false);
          return;
        }
        const fields = buildConfirmPopup(item);
        for (const [k, v] of Object.entries(fields)) {
          const el = modal.querySelector<HTMLElement>(`[data-field='modal-${k}']`);
          if (el) el.textContent = v;
        }
        modal.hidden = false;

        const cancel = modal.querySelector<HTMLButtonElement>("[data-action='modal-cancel']");
        const confirm = modal.querySelector<HTMLButtonElement>("[data-action='modal-confirm']");
        cancel?.focus();

        const cleanup = (result: boolean): void => {
          modal.hidden = true;
          cancel?.removeEventListener("click", onCancel);
          confirm?.removeEventListener("click", onConfirm);
          document.removeEventListener("keydown", onKey);
          resolve(result);
        };
        const onCancel = (): void => cleanup(false);
        const onConfirm = (): void => cleanup(true);
        const onKey = (ev: KeyboardEvent): void => {
          if (ev.key === "Escape") cleanup(false);
        };
        cancel?.addEventListener("click", onCancel);
        confirm?.addEventListener("click", onConfirm);
        document.addEventListener("keydown", onKey);
      }),
  };
}

let dialog: ConfirmDialog = buildBrowserConfirmDialog();
export function setConfirmDialog(d: ConfirmDialog): void {
  dialog = d;
}

/**
 * Walks every requires_confirmation item and asks the user. The shape returns
 * a list of confirmations to feed back into a retry pull. Items the user
 * cancels are simply omitted; the pull returns requires_confirmation again
 * for those next time.
 */
export async function collectConfirmations(
  result: OperationResult,
): Promise<PullOverwriteConfirmation[]> {
  const requests = extractOverwriteRequests(result);
  const confirmations: PullOverwriteConfirmation[] = [];
  for (const r of requests) {
    const ok = await dialog.show(r.item);
    if (ok) confirmations.push(r.confirmation);
  }
  return confirmations;
}

async function pullAll(): Promise<void> {
  if (!currentParentLocalId) return;
  setBusy(true);
  try {
    let result = await postJson<OperationResult>("/api/pull/all", {
      parent: { localId: currentParentLocalId },
    });
    if (!result) return;
    if (result.items.some((i) => i.status === "requires_confirmation")) {
      const confirmations = await collectConfirmations(result);
      if (confirmations.length > 0) {
        result = await postJson<OperationResult>("/api/pull/all", {
          parent: { localId: currentParentLocalId },
          confirmations,
        });
      }
    }
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function pullSelectedRow(): Promise<void> {
  const selected = document.querySelector<HTMLElement>("tr[data-local-id].is-selected");
  if (!selected) return;
  const localId = selected.dataset.localId;
  if (!localId) return;
  setBusy(true);
  try {
    let result = await postJson<OperationResult>("/api/pull/item", {
      item: { localId },
    });
    if (!result) return;
    if (result.items.some((i) => i.status === "requires_confirmation")) {
      const confirmations = await collectConfirmations(result);
      const confirmation = confirmations[0];
      if (confirmation) {
        result = await postJson<OperationResult>("/api/pull/item", {
          item: { localId },
          confirmation,
        });
      }
    }
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function pushAll(): Promise<void> {
  if (!currentParentLocalId) return;
  setBusy(true);
  try {
    let result = await postJson<OperationResult>("/api/push/all", {
      parent: { localId: currentParentLocalId },
      includeParent: true,
    });
    if (!result) return;
    const reparentNeeded = result.items
      .filter((i) => i.confirmationRequired === "change_parent")
      .map((i) => i.localId)
      .filter((id): id is string => id !== undefined);
    if (reparentNeeded.length > 0) {
      // Use the same confirm dialog mechanism for parent-change confirmation.
      const confirmed: string[] = [];
      for (const localId of reparentNeeded) {
        const item = result.items.find((i) => i.localId === localId);
        if (!item) continue;
        const ok = await dialog.show(item);
        if (ok) confirmed.push(localId);
      }
      if (confirmed.length > 0) {
        result = await postJson<OperationResult>("/api/push/all", {
          parent: { localId: currentParentLocalId },
          includeParent: true,
          confirmedParentChanges: confirmed,
        });
      }
    }
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function pushSelectedRow(): Promise<void> {
  const selected = document.querySelector<HTMLElement>("tr[data-local-id].is-selected");
  if (!selected) return;
  const localId = selected.dataset.localId;
  if (!localId) return;
  setBusy(true);
  try {
    let result = await postJson<OperationResult>("/api/push/item", {
      item: { localId },
    });
    if (!result) return;
    if (result.items.some((i) => i.confirmationRequired === "change_parent")) {
      const item = result.items.find((i) => i.localId === localId);
      if (item) {
        const ok = await dialog.show(item);
        if (ok) {
          result = await postJson<OperationResult>("/api/push/item", {
            item: { localId },
            confirmedParentChange: true,
          });
        }
      }
    }
    await refresh();
  } finally {
    setBusy(false);
  }
}

async function validateAll(): Promise<void> {
  await postJson("/api/validate", { scope: "workspace" });
  await refresh();
}

async function validateSelected(): Promise<void> {
  const selected = document.querySelector<HTMLElement>("tr[data-local-id].is-selected");
  const localId = selected?.dataset.localId;
  if (!localId) return;
  await postJson("/api/validate", { scope: "item", item: { localId } });
  await refresh();
}

export type HotkeyHandler = (action: string) => void;

function dispatchAction(action: string): void {
  if (action === "refresh") void refresh();
  else if (action === "pull-all") void pullAll();
  else if (action === "pull-selected") void pullSelectedRow();
  else if (action === "push-all") void pushAll();
  else if (action === "push-selected") void pushSelectedRow();
  else if (action === "validate-all") void validateAll();
  else if (action === "validate-selected") void validateSelected();
  else if (action === "row-validate") void validateSelected();
}

function wireActions(): void {
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!action) return;
    dispatchAction(action);
  });
  document.addEventListener("keydown", (ev) => {
    const action = matchHotkey(ev);
    if (action) {
      ev.preventDefault();
      dispatchAction(action);
    }
  });
  // Row selection toggle.
  document.addEventListener("click", (ev) => {
    const tr = (ev.target as HTMLElement | null)?.closest<HTMLElement>("tr[data-local-id]");
    if (!tr) return;
    for (const other of document.querySelectorAll("tr.is-selected")) {
      other.classList.remove("is-selected");
    }
    tr.classList.add("is-selected");
  });
}

async function pickDefaultParentLocalId(
  status: WorkspaceStatusResponse | null,
): Promise<string | null> {
  if (!status || status.documentCount === 0) return null;
  const fragment = new URLSearchParams(globalThis.location?.hash?.slice(1) ?? "");
  const hashed = fragment.get("parent");
  return hashed ?? null;
}

export async function bootstrap(): Promise<void> {
  const [status, health] = await Promise.all([
    loadJson<WorkspaceStatusResponse>("/api/workspace/status"),
    loadJson<HealthReport>("/api/health"),
  ]);
  applyFooter(renderFooter(status, health?.app.status ?? null));
  wireActions();

  const parentLocalId = await pickDefaultParentLocalId(status);
  if (parentLocalId) await renderParent(parentLocalId);
  else applyParentHero(renderParentHero(null));
}

document.addEventListener("DOMContentLoaded", () => {
  void bootstrap();
});
