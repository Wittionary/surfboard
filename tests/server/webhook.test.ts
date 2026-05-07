import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import {
  getCachedByAdoId,
  openDb,
  updateAcceptedBaseline,
  upsertWorkItemCache,
  type DbHandle,
} from "../../src/server/db.ts";
import { fieldHash, relationHash } from "../../src/server/hash.ts";
import {
  getRecentWebhookEvents,
  processWebhookEvent,
} from "../../src/server/webhookServer.ts";

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function setup(): {
  app: ReturnType<typeof buildAppHandle>["fastify"];
  dbHandle: DbHandle;
  workspaceDir: string;
} {
  const ws = mkdtempSync(join(tmpdir(), "surfboard-webhook-"));
  tempDirs.push(ws);
  // Seed an item with a baseline so we can detect the cache update.
  const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
  dbHandles.push(dbHandle);
  upsertWorkItemCache(dbHandle.db, {
    localId: "feature-a",
    adoId: 100,
    workItemType: "Feature",
    yamlPath: "/x.yaml",
    yamlDocumentIndex: 0,
    syncStatus: "synced",
  });
  updateAcceptedBaseline(dbHandle.db, {
    localId: "feature-a",
    adoId: 100,
    rev: 5,
    fieldHash: fieldHash({
      apiVersion: "surfboard.ado/v1",
      kind: "Feature",
      metadata: { localId: "feature-a", adoId: 100 },
      spec: { fields: { "System.Title": "F" } },
      yamlPath: "/x.yaml",
      yamlDocumentIndex: 0,
    }),
    relationHash: relationHash({
      apiVersion: "surfboard.ado/v1",
      kind: "Feature",
      metadata: { localId: "feature-a", adoId: 100 },
      spec: { fields: {} },
      yamlPath: "/x.yaml",
      yamlDocumentIndex: 0,
    }),
    syncStatus: "synced",
  });

  // Write a templates dir so config loads cleanly.
  writeFileSync(join(ws, "placeholder"), "", "utf8");
  const config = loadConfig({
    env: { ADO_WORKSPACE_DIR: ws, ADO_TEMPLATE_DIR: ws, ADO_WEBHOOK_SECRET: "shh" },
  });
  const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient: null });
  return { app: handle.fastify, dbHandle, workspaceDir: ws };
}

describe("processWebhookEvent (unit)", () => {
  test("rejects when secret mismatches", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);
    const result = processWebhookEvent(
      { db: handle.db, secret: "abc" },
      { "x-surfboard-webhook-secret": "wrong" },
      { eventType: "workitem.updated" },
    );
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("secret_mismatch");
  });

  test("stores raw event with id and rev", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);
    const result = processWebhookEvent(
      { db: handle.db, secret: null },
      {},
      {
        eventType: "workitem.updated",
        resource: { id: 100, rev: 9, fields: { "System.Id": 100, "System.Rev": 9 } },
      },
    );
    expect(result.status).toBe("stored");
    expect(result.adoId).toBe(100);
    expect(result.rev).toBe(9);

    const events = getRecentWebhookEvents(handle.db, 5);
    expect(events.length).toBe(1);
    expect(events[0]?.adoId).toBe(100);
    expect(events[0]?.rev).toBe(9);
  });

  test("marks cache remote_changed when rev exceeds baseline", () => {
    const { dbHandle } = setup();
    const result = processWebhookEvent(
      { db: dbHandle.db, secret: null },
      {},
      { eventType: "workitem.updated", resource: { id: 100, rev: 99 } },
    );
    expect(result.cacheUpdated).toBe(true);
    const cached = getCachedByAdoId(dbHandle.db, 100);
    expect(cached?.syncStatus).toBe("remote_changed");
    expect(cached?.lastRemoteRev).toBe(99);
    // Baseline preserved.
    expect(cached?.lastKnownRev).toBe(5);
  });

  test("does not modify cache when rev equals baseline", () => {
    const { dbHandle } = setup();
    const result = processWebhookEvent(
      { db: dbHandle.db, secret: null },
      {},
      { eventType: "workitem.updated", resource: { id: 100, rev: 5 } },
    );
    expect(result.cacheUpdated).toBe(false);
    const cached = getCachedByAdoId(dbHandle.db, 100);
    expect(cached?.syncStatus).toBe("synced");
  });
});

describe("/api/webhooks/ado", () => {
  test("401 on bad secret", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/ado",
      headers: { "content-type": "application/json", "x-surfboard-webhook-secret": "wrong" },
      payload: JSON.stringify({ eventType: "x" }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  test("200 stores event and returns summary", async () => {
    const { app, dbHandle } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/ado",
      headers: { "content-type": "application/json", "x-surfboard-webhook-secret": "shh" },
      payload: JSON.stringify({
        eventType: "workitem.updated",
        resource: { id: 100, rev: 99 },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cacheUpdated: boolean };
    expect(body.cacheUpdated).toBe(true);
    expect(getRecentWebhookEvents(dbHandle.db).length).toBe(1);
    await app.close();
  });

  test("does not modify YAML or write any local file", async () => {
    const { app, workspaceDir } = setup();
    await app.inject({
      method: "POST",
      url: "/api/webhooks/ado",
      headers: { "content-type": "application/json", "x-surfboard-webhook-secret": "shh" },
      payload: JSON.stringify({ eventType: "workitem.updated", resource: { id: 100, rev: 99 } }),
    });
    // Workspace dir should still contain only what setup() wrote ("placeholder")
    // plus the SQLite directory (.surfboard) but no synthetic YAML.
    const fs = await import("node:fs");
    const entries = fs.readdirSync(workspaceDir);
    expect(entries.includes("placeholder")).toBe(true);
    expect(entries.some((e) => e.endsWith(".yaml"))).toBe(false);
    await app.close();
  });
});
