// Server entry point. Loads config, opens SQLite, starts Fastify.

import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb, type DbHandle } from "./db.ts";
import { log } from "./logger.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  let dbHandle: DbHandle | null = null;
  if (config.workspaceDir) {
    try {
      dbHandle = openDb({ workspaceDir: config.workspaceDir });
    } catch (err) {
      // Surface as health=failed; do not abort. Local-only startup must continue.
      log.error({ err, workspaceDir: config.workspaceDir }, "failed to open SQLite");
    }
  }

  const app = buildApp({ config, dbHandle });

  try {
    await app.listen({ host: config.serverHost, port: config.serverPort });
    log.info(
      { url: `http://${config.serverHost}:${config.serverPort}`, workspaceDir: config.workspaceDir ?? null },
      "listening",
    );
  } catch (err) {
    log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
