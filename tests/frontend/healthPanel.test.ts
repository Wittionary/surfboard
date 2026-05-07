import { describe, expect, test } from "bun:test";
import { renderHealthPanel } from "../../src/frontend/render.ts";
import type { HealthReport } from "../../src/shared/types.ts";

const baseReport: HealthReport = {
  app: { version: "0.1.0", status: "ok" },
  config: { status: "ok", issues: [] },
  sqlite: { status: "ok", path: "/tmp/db" },
  workspace: { status: "ok", path: "/ws" },
  templates: { status: "ok", path: "/ws/templates" },
};

describe("renderHealthPanel", () => {
  test("returns base rows for healthy report", () => {
    const rows = renderHealthPanel(baseReport);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("App");
    expect(labels).toContain("Config");
    expect(labels).toContain("SQLite");
    expect(labels).toContain("Workspace");
    expect(labels).toContain("Templates");
    expect(rows.every((r) => r.status === "ok")).toBe(true);
  });

  test("includes ADO rows when ado is present", () => {
    const rows = renderHealthPanel({ ...baseReport, ado: { auth: "ok", project: "ok" } });
    expect(rows.find((r) => r.label === "ADO Auth")?.status).toBe("ok");
    expect(rows.find((r) => r.label === "ADO Project")).toBeDefined();
  });

  test("renders watcher and webhook when configured", () => {
    const rows = renderHealthPanel({
      ...baseReport,
      watcher: { status: "ok" },
      webhook: { status: "ok", lastEventAt: "2026-05-07T10:00:00Z" },
    });
    expect(rows.find((r) => r.label === "Watcher")?.status).toBe("ok");
    expect(rows.find((r) => r.label === "Webhook")?.detail).toContain("2026-05-07");
  });

  test("last sync row reflects failure/blocked counts", () => {
    const rowsFail = renderHealthPanel({
      ...baseReport,
      lastSync: { at: "2026-05-07T10:00Z", success: 1, failure: 2, blocked: 0 },
    });
    expect(rowsFail.find((r) => r.label === "Last sync")?.status).toBe("failed");

    const rowsBlock = renderHealthPanel({
      ...baseReport,
      lastSync: { at: "2026-05-07T10:00Z", success: 1, failure: 0, blocked: 3 },
    });
    expect(rowsBlock.find((r) => r.label === "Last sync")?.status).toBe("degraded");

    const rowsOk = renderHealthPanel({
      ...baseReport,
      lastSync: { at: "2026-05-07T10:00Z", success: 5, failure: 0, blocked: 0 },
    });
    expect(rowsOk.find((r) => r.label === "Last sync")?.status).toBe("ok");
  });

  test("validation row toggles degraded when issues > 0", () => {
    const rows = renderHealthPanel({
      ...baseReport,
      validation: { lastIssueCount: 3 },
    });
    const v = rows.find((r) => r.label === "Validation");
    expect(v?.status).toBe("degraded");
    expect(v?.detail).toContain("3 issues");
  });

  test("loading state when report is null", () => {
    const rows = renderHealthPanel(null);
    expect(rows[0]?.status).toBe("unknown");
  });

  test("degraded config detail lists issues", () => {
    const rows = renderHealthPanel({
      ...baseReport,
      config: { status: "degraded", issues: ["ado_org_missing", "ado_pat_missing"] },
    });
    const c = rows.find((r) => r.label === "Config");
    expect(c?.status).toBe("degraded");
    expect(c?.detail).toContain("ado_org_missing");
  });
});
