// Fastify app factory. Phase 1 wires only health; later phases register pull/push/audit routes.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.ts";
import type { DbHandle } from "./db.ts";
import { FileWatcher } from "./fileWatcher.ts";
import { buildHealthReport } from "./health.ts";
import { registerLocalRoutes } from "./routes.ts";
import { registerStatic } from "./static.ts";
import { WorkspaceState } from "./workspaceState.ts";

export type AppDeps = {
  config: AppConfig;
  dbHandle: DbHandle | null;
  /** Defaults to dist/frontend relative to the project root. Pass null to disable static serving (tests). */
  staticRoot?: string | null;
  /** When true, start a chokidar watcher that re-scans on file change. Default false (tests opt in). */
  startWatcher?: boolean;
};

export type AppHandle = {
  fastify: FastifyInstance;
  workspace: WorkspaceState | null;
  watcher: FileWatcher | null;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  return buildAppHandle(deps).fastify;
}

export function buildAppHandle(deps: AppDeps): AppHandle {
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
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
      });
      watcher.start();
    }
  }

  fastify.get("/api/health", async () => {
    return buildHealthReport({ config: deps.config, dbHandle: deps.dbHandle, watcher });
  });

  if (deps.staticRoot !== null) {
    const root = deps.staticRoot ?? resolve(process.cwd(), "dist/frontend");
    if (existsSync(root)) {
      registerStatic(fastify, { root });
    }
  }

  return { fastify, workspace, watcher };
}
