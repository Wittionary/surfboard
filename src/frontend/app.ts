// Phase 1 frontend bootstrap. Loads health into the footer; later phases wire data and actions.

import type { HealthReport } from "../shared/types.ts";

type FieldName = "lastSync" | "health" | "version";

function setText(field: FieldName, text: string): void {
  const el = document.querySelector<HTMLElement>(`[data-field="${field}"]`);
  if (el) el.textContent = text;
}

async function loadHealth(): Promise<void> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const report = (await res.json()) as HealthReport;
    setText("version", `Version: ${report.app.version}`);
    setText("health", `Health: ${report.app.status}`);
  } catch (err) {
    setText("health", `Health: unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void loadHealth();
});
