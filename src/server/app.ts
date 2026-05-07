// Fastify app factory. Phase 1 wires only health; later phases register pull/push/audit routes.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.ts";
import type { DbHandle } from "./db.ts";
import { buildHealthReport } from "./health.ts";
import { registerStatic } from "./static.ts";

export type AppDeps = {
  config: AppConfig;
  dbHandle: DbHandle | null;
  /** Defaults to dist/frontend relative to the project root. Pass null to disable static serving (tests). */
  staticRoot?: string | null;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  fastify.get("/api/health", async () => {
    return buildHealthReport({ config: deps.config, dbHandle: deps.dbHandle });
  });

  if (deps.staticRoot !== null) {
    const root = deps.staticRoot ?? resolve(process.cwd(), "dist/frontend");
    if (existsSync(root)) {
      registerStatic(fastify, { root });
    }
  }

  return fastify;
}
