// Server entry point. Loads config, opens SQLite, starts Fastify.

import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb, type DbHandle } from "./db.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  let dbHandle: DbHandle | null = null;
  if (config.workspaceDir) {
    try {
      dbHandle = openDb({ workspaceDir: config.workspaceDir });
    } catch (err) {
      // Surface as health=failed; do not abort. Local-only startup must continue.
      console.error("[surfboard] failed to open SQLite:", err);
    }
  }

  const app = buildApp({ config, dbHandle });

  try {
    await app.listen({ host: config.serverHost, port: config.serverPort });
    console.log(`[surfboard] listening on http://${config.serverHost}:${config.serverPort}`);
  } catch (err) {
    console.error("[surfboard] failed to start server:", err);
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
