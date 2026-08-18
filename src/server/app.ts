// Fastify app factory. Phase 1 wires only health; later phases register pull/push/audit routes.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AdoClient } from "./adoClient.ts";
import type { AppConfig } from "./config.ts";
import type { DbHandle } from "./db.ts";
import { FileWatcher } from "./fileWatcher.ts";
import { buildHealthReport } from "./health.ts";
import { childLog } from "./logger.ts";
import {
  registerAuditRoutes,
  registerLocalRoutes,
  registerPullRoutes,
  registerScaffoldRoutes,
  registerWebhookRoutes,
} from "./routes.ts";
import { registerStatic } from "./static.ts";
import { WorkspaceState } from "./workspaceState.ts";

const log = childLog("http");

export type AppDeps = {
  config: AppConfig;
  dbHandle: DbHandle | null;
  /** Defaults to dist/frontend relative to the project root. Pass null to disable static serving (tests). */
  staticRoot?: string | null;
  /** When true, start a chokidar watcher that re-scans on file change. Default false (tests opt in). */
  startWatcher?: boolean;
  /** Inject a custom AdoClient (tests). When omitted, one is constructed from config.ado if present. */
  adoClient?: AdoClient | null;
};

export type AppHandle = {
  fastify: FastifyInstance;
  workspace: WorkspaceState | null;
  watcher: FileWatcher | null;
  adoClient: AdoClient | null;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  return buildAppHandle(deps).fastify;
}

export function buildAppHandle(deps: AppDeps): AppHandle {
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  fastify.addHook("onResponse", (req, reply, done) => {
    const ms = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 400) {
      log.warn({ method: req.method, url: req.url, status: reply.statusCode, ms }, "http");
    } else {
      log.debug({ method: req.method, url: req.url, status: reply.statusCode, ms }, "http");
    }
    done();
  });

  let workspace: WorkspaceState | null = null;
  let watcher: FileWatcher | null = null;
  if (deps.dbHandle && deps.config.workspaceDir && deps.config.templateDir) {
    workspace = new WorkspaceState({
      workspaceDir: deps.config.workspaceDir,
      templateDir: deps.config.templateDir,
      db: deps.dbHandle.db,
    });
    registerLocalRoutes(fastify, { workspace });

    if (deps.startWatcher) {
      const ws = workspace;
      watcher = new FileWatcher({
        workspaceDir: deps.config.workspaceDir,
        templateDir: deps.config.templateDir,
        onChange: () => {
          ws.refresh({ pruneOrphans: true });
        },
        ...resolveWatcherPolling(),
      });
      void watcher.start();
    }
  }

  // If the caller explicitly passes adoClient (including null), honor it.
  // Otherwise auto-construct from config when ADO is configured.
  let adoClient: AdoClient | null;
  if ("adoClient" in deps) {
    adoClient = deps.adoClient ?? null;
  } else if (deps.config.ado) {
    adoClient = new AdoClient({
      organization: deps.config.ado.org,
      project: deps.config.ado.project,
      apiVersion: deps.config.ado.apiVersion,
      pat: deps.config.ado.pat,
    });
  } else {
    adoClient = null;
  }

  if (workspace && deps.dbHandle) {
    registerScaffoldRoutes(fastify, { workspace, db: deps.dbHandle.db });
  }

  if (workspace && deps.dbHandle && adoClient) {
    registerPullRoutes(fastify, {
      workspace,
      client: adoClient,
      db: deps.dbHandle.db,
      workspaceDir: deps.config.workspaceDir,
      templateDir: deps.config.templateDir,
      pat: deps.config.ado?.pat,
    });
  }

  if (deps.dbHandle) {
    registerWebhookRoutes(fastify, {
      db: deps.dbHandle.db,
      secret: deps.config.webhookSecret,
    });
    registerAuditRoutes(fastify, { db: deps.dbHandle.db });
  }

  fastify.get("/api/health", async () => {
    const lastSync = workspace?.getLastSync();
    const lastIssueCount = workspace?.current().scan.issues.length;
    return buildHealthReport({
      config: deps.config,
      dbHandle: deps.dbHandle,
      watcher,
      adoClient,
      ...(lastSync ? { lastSync } : {}),
      ...(typeof lastIssueCount === "number" ? { lastIssueCount } : {}),
    });
  });

  if (deps.staticRoot !== null) {
    const root = deps.staticRoot ?? resolve(process.cwd(), "dist/frontend");
    if (existsSync(root)) {
      registerStatic(fastify, { root });
    }
  }

  return { fastify, workspace, watcher, adoClient };
}

// SURFBOARD_WATCH_POLLING: "0"/"false"/"off" forces native filesystem events;
// any other value (including unset) keeps the FileWatcher default of polling
// on, which is the correct mode for container bind mounts on Docker Desktop.
export function resolveWatcherPolling(): { usePolling?: boolean } {
  const raw = process.env.SURFBOARD_WATCH_POLLING?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") {
    return { usePolling: false };
  }
  return {};
}
