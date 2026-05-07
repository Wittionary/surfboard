// Boots the Surfboard app in-process and asserts /api/health responds with a
// structured report. Uses Fastify's `inject` so this works without binding a port.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { openDb } from "../src/server/db.ts";
import type { HealthReport } from "../src/shared/types.ts";

const ws = mkdtempSync(join(tmpdir(), "surfboard-smoke-"));
let exitCode = 0;
try {
  const config = loadConfig({
    env: {
      ADO_WORKSPACE_DIR: ws,
      ADO_TEMPLATE_DIR: ws,
      ADO_ORG: process.env.ADO_ORG,
      ADO_PROJECT: process.env.ADO_PROJECT,
      ADO_PAT: process.env.ADO_PAT,
    },
  });
  const dbHandle = openDb({ workspaceDir: ws });
  const app = buildApp({ config, dbHandle, staticRoot: null });

  const res = await app.inject({ method: "GET", url: "/api/health" });
  if (res.statusCode !== 200) {
    console.error(`[smoke-health] expected 200, got ${res.statusCode}`);
    process.exit(1);
  }
  const report = res.json() as HealthReport;
  if (!report.app?.version) {
    console.error("[smoke-health] missing app.version in report");
    process.exit(1);
  }
  if (report.sqlite.status !== "ok") {
    console.error(`[smoke-health] sqlite not ok: ${JSON.stringify(report.sqlite)}`);
    process.exit(1);
  }
  console.log(`[smoke-health] ok — app=${report.app.status} sqlite=${report.sqlite.status} version=${report.app.version}`);

  await app.close();
  dbHandle.close();
} catch (err) {
  console.error("[smoke-health] failed:", err);
  exitCode = 1;
} finally {
  rmSync(ws, { recursive: true, force: true });
}
process.exit(exitCode);
