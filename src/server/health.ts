// Health report aggregator. Components contribute a HealthStatus and
// (optionally) a free-text error. The route handler awaits this.

import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { publicConfig } from "./config.ts";
import type { AdoClient } from "./adoClient.ts";
import { AdoError } from "./adoClient.ts";
import type { DbHandle } from "./db.ts";
import type { FileWatcher } from "./fileWatcher.ts";
import { getCurrentVersion } from "./migrations.ts";
import { APP_VERSION } from "../shared/constants.ts";
import type { HealthReport, HealthStatus } from "../shared/types.ts";

export type BuildHealthOptions = {
  config: AppConfig;
  dbHandle: DbHandle | null;
  watcher?: FileWatcher | null;
  /** When provided, probeAdoHealth is invoked and the result is included. */
  adoClient?: AdoClient | null;
  /** Optional last sync summary, populated by routes after each operation. */
  lastSync?: {
    at?: string;
    success: number;
    failure: number;
    blocked: number;
  };
  /** Last validation issue count, fed in by the workspace state when known. */
  lastIssueCount?: number;
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

export async function buildHealthReport(options: BuildHealthOptions): Promise<HealthReport> {
  const config = configStatus(options.config);
  const sqlite = sqliteStatus(options.dbHandle);
  const workspace = dirStatus(options.config.workspaceDir);
  const templates = dirStatus(options.config.templateDir);
  const watcher = options.watcher
    ? {
        status: (options.watcher.status.active ? "ok" : "failed") as HealthStatus,
        error: options.watcher.status.error,
      }
    : undefined;

  let ado: HealthReport["ado"];
  if (options.config.ado === null) {
    ado = {
      auth: "disabled",
      project: "disabled",
      lastError: "ADO config missing — pull and push routes are unavailable",
    };
  } else if (options.adoClient) {
    ado = await probeAdoHealth(options.adoClient);
  }

  const overall = appStatus(
    [config.status, sqlite.status, workspace.status, templates.status, watcher?.status, ado?.auth].filter(
      (s): s is HealthStatus => s !== undefined && s !== "disabled",
    ),
  );

  return {
    app: { version: APP_VERSION, status: overall },
    config,
    sqlite,
    workspace,
    templates,
    ...(watcher ? { watcher } : {}),
    ...(ado ? { ado } : {}),
    ...(options.lastSync ? { lastSync: options.lastSync } : {}),
    ...(options.lastIssueCount !== undefined
      ? { validation: { lastIssueCount: options.lastIssueCount } }
      : {}),
  };
}

/**
 * Probes ADO with a single read-only project GET. Distinguishes:
 * - ok: project responds 200
 * - auth failed: 401 or 403
 * - project failed: 404 (auth presumably ok)
 * - degraded: any other error
 */
export async function probeAdoHealth(client: AdoClient): Promise<NonNullable<HealthReport["ado"]>> {
  try {
    await client.getJsonOrg(`projects/${encodeURIComponent(client.project)}`);
    return { auth: "ok", project: "ok" };
  } catch (err) {
    if (err instanceof AdoError) {
      if (err.status === 401 || err.status === 403) {
        return { auth: "failed", project: "failed", lastError: `${err.status} ${err.statusText}` };
      }
      if (err.status === 404) {
        return { auth: "ok", project: "failed", lastError: `${err.status} ${err.statusText}` };
      }
      return {
        auth: "degraded",
        project: "degraded",
        lastError: `${err.status} ${err.statusText}`,
      };
    }
    return {
      auth: "degraded",
      project: "degraded",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}
