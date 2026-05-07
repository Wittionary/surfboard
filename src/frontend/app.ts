// Phase 2 frontend: load workspace status, find a default parent, and render
// the parent hero + child grid + footer. Pull/push wiring comes in Phase 3+.

import type {
  ParentViewResponse,
  WorkspaceStatusResponse,
} from "../server/routes.ts";
import type { HealthReport } from "../shared/types.ts";
import {
  buildLocalViewModel,
  renderChildRows,
  renderFooter,
  renderParentHero,
} from "./render.ts";

async function loadJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function applyParentHero(view: ReturnType<typeof renderParentHero>): void {
  for (const [field, value] of Object.entries(view)) {
    const map: Record<string, string> = {
      type: "kind",
      title: "title",
      adoId: "adoId",
      state: "state",
      syncStatus: "syncStatus",
      yamlPath: "yamlPath",
    };
    const sel = map[field];
    if (!sel) continue;
    if (sel === "title") {
      const el = document.querySelector("[data-field='title']");
      if (el) el.textContent = value;
    } else {
      const el = document.querySelector(`[data-field='${sel}']`);
      if (el) el.textContent = value;
    }
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

async function pickDefaultParentLocalId(
  status: WorkspaceStatusResponse | null,
): Promise<string | null> {
  if (!status || status.documentCount === 0) return null;
  // We don't have a list endpoint yet; query by validate scope=workspace would
  // also need item identities. As a Phase-2 stand-in, ask the user-supplied
  // hash or the first found Epic via /api/view/parent/<best-guess>.
  // For now we rely on a URL hash, e.g. #parent=epic-platform-reliability.
  const fragment = new URLSearchParams(globalThis.location?.hash?.slice(1) ?? "");
  const hashed = fragment.get("parent");
  if (hashed) return hashed;
  return null;
}

export async function bootstrap(): Promise<void> {
  const [status, health] = await Promise.all([
    loadJson<WorkspaceStatusResponse>("/api/workspace/status"),
    loadJson<HealthReport>("/api/health"),
  ]);

  applyFooter(renderFooter(status, health?.app.status ?? null));

  const parentLocalId = await pickDefaultParentLocalId(status);
  let parent: ParentViewResponse | null = null;
  if (parentLocalId) {
    parent = await loadJson<ParentViewResponse>(
      `/api/view/parent/${encodeURIComponent(parentLocalId)}`,
    );
  }

  const model = buildLocalViewModel(parent);
  applyParentHero(renderParentHero(model.parent));
  applyChildRows(renderChildRows(model.children));
}

document.addEventListener("DOMContentLoaded", () => {
  void bootstrap();
});
