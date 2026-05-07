import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import type { HealthReport } from "../../src/shared/types.ts";

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeTempWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "surfboard-health-"));
  tempDirs.push(ws);
  return ws;
}

afterEach(() => {
  while (dbHandles.length > 0) {
    const h = dbHandles.pop();
    h?.close();
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

async function getHealth(app: ReturnType<typeof buildApp>): Promise<HealthReport> {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  return res.json() as HealthReport;
}

describe("/api/health", () => {
  test("reports healthy state when config and SQLite are present", async () => {
    const ws = makeTempWorkspace();
    const env = {
      ADO_ORG: "goalliant",
      ADO_PROJECT: "Alliant",
      ADO_PAT: "test-pat",
      ADO_WORKSPACE_DIR: ws,
      ADO_TEMPLATE_DIR: ws,
    };
    const config = loadConfig({ env });
    const dbHandle = openDb({ workspaceDir: ws });
    dbHandles.push(dbHandle);

    const app = buildApp({ config, dbHandle, adoClient: null });
    const report = await getHealth(app);

    expect(report.app.status).toBe("ok");
    expect(report.config.status).toBe("ok");
    expect(report.sqlite.status).toBe("ok");
    expect(report.workspace.status).toBe("ok");
    expect(report.templates.status).toBe("ok");
    expect(report.config.organization).toBe("goalliant");
    expect(JSON.stringify(report)).not.toContain("test-pat");
    await app.close();
  });

  test("reports degraded state when ADO config is missing", async () => {
    const ws = makeTempWorkspace();
    const config = loadConfig({
      env: { ADO_WORKSPACE_DIR: ws, ADO_TEMPLATE_DIR: ws },
    });
    const dbHandle = openDb({ workspaceDir: ws });
    dbHandles.push(dbHandle);

    const app = buildApp({ config, dbHandle, adoClient: null });
    const report = await getHealth(app);

    expect(report.config.status).toBe("degraded");
    expect(report.config.issues).toContain("ado_org_missing");
    expect(report.config.organization).toBeUndefined();
    expect(report.app.status).toBe("degraded");
    await app.close();
  });

  test("reports failed when SQLite is unavailable", async () => {
    const ws = makeTempWorkspace();
    const config = loadConfig({
      env: {
        ADO_ORG: "goalliant",
        ADO_PROJECT: "Alliant",
        ADO_PAT: "test-pat",
        ADO_WORKSPACE_DIR: ws,
        ADO_TEMPLATE_DIR: ws,
      },
    });
    const app = buildApp({ config, dbHandle: null, adoClient: null });
    const report = await getHealth(app);

    expect(report.sqlite.status).toBe("failed");
    expect(report.app.status).toBe("failed");
    await app.close();
  });

  test("reports failed when workspace dir does not exist", async () => {
    const config = loadConfig({
      env: {
        ADO_ORG: "goalliant",
        ADO_PROJECT: "Alliant",
        ADO_PAT: "test-pat",
        ADO_WORKSPACE_DIR: "/tmp/surfboard-does-not-exist-xyz",
        ADO_TEMPLATE_DIR: "/tmp/surfboard-does-not-exist-xyz/templates",
      },
    });
    const app = buildApp({ config, dbHandle: null, adoClient: null });
    const report = await getHealth(app);

    expect(report.workspace.status).toBe("degraded");
    expect(report.templates.status).toBe("degraded");
    await app.close();
  });
});
