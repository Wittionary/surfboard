// Environment configuration loader per spec §11.1 and decisions doc.
//
// Hard rules:
// - The PAT is never persisted, logged, serialized, or returned by `publicConfig`.
// - Missing ADO config does not prevent server startup; it produces an `ado: null`
//   config plus an `issues` entry, and ADO-touching routes/health checks must
//   refuse to operate when `config.ado` is null.

import { resolve } from "node:path";
import { ADO_API_VERSION_DEFAULT, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../shared/constants.ts";

export type AdoConfig = {
  org: string;
  project: string;
  apiVersion: string;
  pat: string;
};

export type AppConfig = {
  workspaceDir: string;
  templateDir: string;
  ado: AdoConfig | null;
  webhookSecret: string | null;
  serverHost: string;
  serverPort: number;
  /** Non-fatal issues. Each entry is a stable code; the matching detail is logged separately. */
  issues: ConfigIssue[];
};

export type ConfigIssue =
  | "ado_org_missing"
  | "ado_project_missing"
  | "ado_pat_missing"
  | "workspace_dir_missing"
  | "template_dir_missing";

export type PublicAdoConfig = {
  org: string;
  project: string;
  apiVersion: string;
};

export type PublicAppConfig = {
  workspaceDir: string;
  templateDir: string;
  ado: PublicAdoConfig | null;
  webhookConfigured: boolean;
  serverHost: string;
  serverPort: number;
  issues: ConfigIssue[];
};

export type LoadConfigOptions = {
  env?: Record<string, string | undefined>;
};

const trim = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const issues: ConfigIssue[] = [];

  const org = trim(env.ADO_ORG);
  const project = trim(env.ADO_PROJECT);
  const pat = trim(env.ADO_PAT);
  const apiVersion = trim(env.ADO_API_VERSION) ?? ADO_API_VERSION_DEFAULT;

  const workspaceDirRaw = trim(env.ADO_WORKSPACE_DIR);
  const templateDirRaw = trim(env.ADO_TEMPLATE_DIR);

  if (!workspaceDirRaw) issues.push("workspace_dir_missing");
  if (!templateDirRaw) issues.push("template_dir_missing");
  if (!org) issues.push("ado_org_missing");
  if (!project) issues.push("ado_project_missing");
  if (!pat) issues.push("ado_pat_missing");

  const workspaceDir = workspaceDirRaw ? resolve(workspaceDirRaw) : "";
  const templateDir = templateDirRaw ? resolve(templateDirRaw) : "";

  const ado: AdoConfig | null = org && project && pat
    ? { org, project, apiVersion, pat }
    : null;

  const webhookSecret = trim(env.ADO_WEBHOOK_SECRET) ?? null;

  return {
    workspaceDir,
    templateDir,
    ado,
    webhookSecret,
    serverHost: trim(env.SURFBOARD_HOST) ?? DEFAULT_SERVER_HOST,
    serverPort: parsePort(trim(env.SURFBOARD_PORT)) ?? DEFAULT_SERVER_PORT,
    issues,
  };
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

export function publicConfig(config: AppConfig): PublicAppConfig {
  return {
    workspaceDir: config.workspaceDir,
    templateDir: config.templateDir,
    ado: config.ado
      ? {
          org: config.ado.org,
          project: config.ado.project,
          apiVersion: config.ado.apiVersion,
        }
      : null,
    webhookConfigured: config.webhookSecret !== null,
    serverHost: config.serverHost,
    serverPort: config.serverPort,
    issues: [...config.issues],
  };
}
