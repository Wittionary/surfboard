// Phase 1 health report. Phases 2, 3, and 5 expand this with watcher, ADO, and webhook fields.

import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { publicConfig } from "./config.ts";
import type { DbHandle } from "./db.ts";
import { getCurrentVersion } from "./migrations.ts";
import { APP_VERSION } from "../shared/constants.ts";
import type { HealthReport, HealthStatus } from "../shared/types.ts";

export type BuildHealthOptions = {
  config: AppConfig;
  dbHandle: DbHandle | null;
};

function dirStatus(path: string | undefined): { status: HealthStatus; path?: string; error?: string } {
  if (!path) return { status: "failed", error: "not configured" };
  try {
    if (!existsSync(path)) return { status: "degraded", path, error: "directory does not exist" };
    const st = statSync(path);
    if (!st.isDirectory()) return { status: "failed", path, error: "path is not a directory" };
    return { status: "ok", path };
  } catch (err) {
    return { status: "failed", path, error: err instanceof Error ? err.message : String(err) };
  }
}

function sqliteStatus(handle: DbHandle | null): HealthReport["sqlite"] {
  if (!handle) return { status: "failed", error: "database not opened" };
  try {
    const version = getCurrentVersion(handle.db);
    if (version <= 0) return { status: "failed", path: handle.path, error: "no migrations applied" };
    return { status: "ok", path: handle.path };
  } catch (err) {
    return { status: "failed", path: handle.path, error: err instanceof Error ? err.message : String(err) };
  }
}

function configStatus(config: AppConfig): HealthReport["config"] {
  const blockers = config.issues.filter(
    (i) => i === "workspace_dir_missing" || i === "template_dir_missing",
  );
  const status: HealthStatus = blockers.length > 0 ? "failed" : config.issues.length > 0 ? "degraded" : "ok";
  const pub = publicConfig(config);
  return {
    status,
    workspaceDir: pub.workspaceDir || undefined,
    templateDir: pub.templateDir || undefined,
    organization: pub.ado?.org,
    project: pub.ado?.project,
    apiVersion: pub.ado?.apiVersion,
    issues: pub.issues,
  };
}

function appStatus(parts: ReadonlyArray<HealthStatus>): HealthStatus {
  if (parts.some((p) => p === "failed")) return "failed";
  if (parts.some((p) => p === "degraded")) return "degraded";
  return "ok";
}

export function buildHealthReport(options: BuildHealthOptions): HealthReport {
  const config = configStatus(options.config);
  const sqlite = sqliteStatus(options.dbHandle);
  const workspace = dirStatus(options.config.workspaceDir);
  const templates = dirStatus(options.config.templateDir);
  const overall = appStatus([config.status, sqlite.status, workspace.status, templates.status]);

  return {
    app: { version: APP_VERSION, status: overall },
    config,
    sqlite,
    workspace,
    templates,
  };
}
