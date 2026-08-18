// The container's `docker compose down` depends on the server exiting cleanly
// on SIGTERM rather than being SIGKILLed after a timeout. That only happens in
// a real process, so this spawns one.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");
const SERVER_ENTRY = resolve(import.meta.dir, "../../src/server/index.ts");
const BOOT_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-shutdown-"));
  tempDirs.push(workspaceDir);
  const templateDir = join(workspaceDir, "templates");
  mkdirSync(templateDir, { recursive: true });
  for (const name of [
    "epic.schema.yaml",
    "feature.schema.yaml",
    "pbi.schema.yaml",
    "enabler.schema.yaml",
    "task.schema.yaml",
  ]) {
    copyFileSync(join(FIXTURE_TEMPLATES, name), join(templateDir, name));
  }
  return { workspaceDir, templateDir };
}

// Ephemeral-ish port per signal so concurrent runs do not collide.
function portFor(signal: string): number {
  return 39_000 + (signal === "SIGTERM" ? 1 : 2);
}

async function waitForHealth(port: number): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("server shutdown", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} exits cleanly within ${EXIT_TIMEOUT_MS}ms`, async () => {
      const ws = makeWorkspace();
      const port = portFor(signal);
      const proc = Bun.spawn(["bun", "run", SERVER_ENTRY], {
        env: {
          ...process.env,
          ADO_WORKSPACE_DIR: ws.workspaceDir,
          ADO_TEMPLATE_DIR: ws.templateDir,
          SURFBOARD_HOST: "127.0.0.1",
          SURFBOARD_PORT: String(port),
          // Keep ADO unconfigured — shutdown must not depend on it.
          ADO_ORG: "",
          ADO_PROJECT: "",
          ADO_PAT: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        expect(await waitForHealth(port)).toBe(true);

        proc.kill(signal);
        const exitCode = await Promise.race([
          proc.exited,
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), EXIT_TIMEOUT_MS)),
        ]);

        // Not "timeout" proves we did not need a SIGKILL; 0 proves the handler
        // ran rather than the process dying from the default signal action.
        expect(exitCode).toBe(0);
      } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    }, 30_000);
  }
});
