// Fastify app factory. Phase 1 wires only health; later phases register pull/push/audit routes.

import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.ts";
import type { DbHandle } from "./db.ts";
import { buildHealthReport } from "./health.ts";

export type AppDeps = {
  config: AppConfig;
  dbHandle: DbHandle | null;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  fastify.get("/api/health", async () => {
    return buildHealthReport({ config: deps.config, dbHandle: deps.dbHandle });
  });

  return fastify;
}
