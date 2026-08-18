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

  // Spec §120: the running app watches the workspace directory. Tests opt in
  // explicitly; the real server is the only other place that should.
  const app = buildApp({ config, dbHandle, startWatcher: true });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutdown requested");
    void app
      .close()
      .catch((err) => log.error({ err }, "fastify close failed"))
      .finally(() => {
        try {
          dbHandle?.close();
        } catch (err) {
          log.error({ err }, "sqlite close failed");
        }
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

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
