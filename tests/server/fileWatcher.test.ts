import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileWatcher } from "../../src/server/fileWatcher.ts";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";

const FIXTURE_TEMPLATES = resolve(import.meta.dir, "../fixtures/templates");

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];
const watchers: FileWatcher[] = [];

function makeWorkspace(): { workspaceDir: string; templateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "surfboard-watch-"));
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

afterEach(async () => {
  for (const w of watchers) await w.stop();
  watchers.length = 0;
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FileWatcher", () => {
  test("debounces multiple changes into a single onChange call", async () => {
    const { workspaceDir } = makeWorkspace();
    let callCount = 0;
    const w = new FileWatcher({
      workspaceDir,
      onChange: () => {
        callCount += 1;
      },
      debounceMs: 80,
    });
    watchers.push(w);
    await w.start();
    expect(w.status.active).toBe(true);

    const path = join(workspaceDir, "a.yaml");
    writeFileSync(path, "x: 1\n", "utf8");
    writeFileSync(path, "x: 2\n", "utf8");
    writeFileSync(path, "x: 3\n", "utf8");

    await wait(300);
    expect(callCount).toBeGreaterThanOrEqual(1);
    // Three writes within debounce should collapse — generally to 1 call.
    expect(callCount).toBeLessThanOrEqual(2);
  });

  test("stop() cleans up so subsequent file changes do not fire onChange", async () => {
    const { workspaceDir } = makeWorkspace();
    let callCount = 0;
    const w = new FileWatcher({
      workspaceDir,
      onChange: () => {
        callCount += 1;
      },
      debounceMs: 50,
    });
    watchers.push(w);
    await w.start();

    writeFileSync(join(workspaceDir, "a.yaml"), "a: 1\n", "utf8");
    await wait(200);
    const after = callCount;

    await w.stop();
    expect(w.status.active).toBe(false);

    writeFileSync(join(workspaceDir, "a.yaml"), "a: 2\n", "utf8");
    await wait(200);
    expect(callCount).toBe(after);
  });

  test("integration: watcher refreshes workspace state without calling any sync route", async () => {
    const ws = makeWorkspace();
    const items = join(ws.workspaceDir, "workitems");
    mkdirSync(items, { recursive: true });

    const config = loadConfig({
      env: { ADO_WORKSPACE_DIR: ws.workspaceDir, ADO_TEMPLATE_DIR: ws.templateDir },
    });
    const dbHandle = openDb({ workspaceDir: ws.workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const handle = buildAppHandle({
      config,
      dbHandle,
      staticRoot: null,
      startWatcher: true,
    });
    if (handle.watcher) watchers.push(handle.watcher);

    // Workspace starts empty.
    let res = await handle.fastify.inject({ method: "GET", url: "/api/workspace/status" });
    expect(JSON.parse(res.body).documentCount).toBe(0);

    // Add a YAML file after chokidar reports readiness. The watcher should re-scan.
    await handle.watcher?.start();
    writeFileSync(
      join(items, "p.yaml"),
      `apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: p
spec:
  parent:
    adoId: 1
  fields:
    System.Title: P
`,
      "utf8",
    );
    await wait(500);

    res = await handle.fastify.inject({ method: "GET", url: "/api/workspace/status" });
    expect(JSON.parse(res.body).documentCount).toBe(1);

    // Confirm no /api/pull or /api/push route was hit by the watcher: those
    // routes don't exist yet, so any registered route must be local-only.
    const routes = (handle.fastify.printRoutes() ?? "");
    expect(routes).not.toContain("/api/pull");
    expect(routes).not.toContain("/api/push");

    await handle.fastify.close();
  });

  test("health report includes watcher status when watcher is running", async () => {
    const ws = makeWorkspace();
    const config = loadConfig({
      env: { ADO_WORKSPACE_DIR: ws.workspaceDir, ADO_TEMPLATE_DIR: ws.templateDir },
    });
    const dbHandle = openDb({ workspaceDir: ws.workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const handle = buildAppHandle({
      config,
      dbHandle,
      staticRoot: null,
      startWatcher: true,
    });
    if (handle.watcher) watchers.push(handle.watcher);
    await handle.watcher?.start();

    const res = await handle.fastify.inject({ method: "GET", url: "/api/health" });
    const body = JSON.parse(res.body);
    expect(body.watcher).toBeDefined();
    expect(body.watcher.status).toBe("ok");
    await handle.fastify.close();
  });
});
