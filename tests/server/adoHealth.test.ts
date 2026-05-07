import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import { buildAppHandle } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";
import { probeAdoHealth } from "../../src/server/health.ts";
import type { HealthReport } from "../../src/shared/types.ts";

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function makeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((url: RequestInfo | URL): Promise<Response> => Promise.resolve(handler(String(url)))) as typeof fetch;
}

function clientWith(handler: (url: string) => Response | Promise<Response>): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: makeFetch(handler),
  });
}

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("probeAdoHealth", () => {
  test("returns ok when project responds 200", async () => {
    const c = clientWith(() => new Response(JSON.stringify({ id: "x", name: "Alliant" }), { status: 200 }));
    const result = await probeAdoHealth(c);
    expect(result.auth).toBe("ok");
    expect(result.project).toBe("ok");
    expect(result.lastError).toBeUndefined();
  });

  test("401 produces auth=failed and project=failed", async () => {
    const c = clientWith(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const result = await probeAdoHealth(c);
    expect(result.auth).toBe("failed");
    expect(result.project).toBe("failed");
    expect(result.lastError).toContain("401");
  });

  test("403 produces auth=failed", async () => {
    const c = clientWith(() => new Response("forbidden", { status: 403, statusText: "Forbidden" }));
    const result = await probeAdoHealth(c);
    expect(result.auth).toBe("failed");
    expect(result.project).toBe("failed");
  });

  test("404 produces auth=ok and project=failed", async () => {
    const c = clientWith(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const result = await probeAdoHealth(c);
    expect(result.auth).toBe("ok");
    expect(result.project).toBe("failed");
  });

  test("network failure produces degraded with redacted message", async () => {
    const c = clientWith(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    });
    const result = await probeAdoHealth(c);
    expect(result.auth).toBe("degraded");
    expect(result.project).toBe("degraded");
  });
});

describe("/api/health with ADO config", () => {
  test("ado=disabled when ADO config is missing (degraded but local available)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "surfboard-ado-h-"));
    tempDirs.push(ws);
    const config = loadConfig({
      env: { ADO_WORKSPACE_DIR: ws, ADO_TEMPLATE_DIR: ws },
    });
    const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
    dbHandles.push(dbHandle);
    const handle = buildAppHandle({ config, dbHandle, staticRoot: null });
    const res = await handle.fastify.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as HealthReport;
    expect(body.ado?.auth).toBe("disabled");
    expect(body.ado?.lastError).toContain("ADO config missing");
    expect(body.config.status).toBe("degraded");
    await handle.fastify.close();
  });

  test("ado=ok when client probe succeeds", async () => {
    const ws = mkdtempSync(join(tmpdir(), "surfboard-ado-h-"));
    tempDirs.push(ws);
    const config = loadConfig({
      env: {
        ADO_ORG: "goalliant",
        ADO_PROJECT: "Alliant",
        ADO_PAT: "fake",
        ADO_WORKSPACE_DIR: ws,
        ADO_TEMPLATE_DIR: ws,
      },
    });
    const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
    dbHandles.push(dbHandle);
    const adoClient = clientWith(() => new Response("{}", { status: 200 }));
    const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient });
    const res = await handle.fastify.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as HealthReport;
    expect(body.ado?.auth).toBe("ok");
    expect(body.ado?.project).toBe("ok");
    await handle.fastify.close();
  });

  test("ado=auth-failed when probe returns 401", async () => {
    const ws = mkdtempSync(join(tmpdir(), "surfboard-ado-h-"));
    tempDirs.push(ws);
    const config = loadConfig({
      env: {
        ADO_ORG: "goalliant",
        ADO_PROJECT: "Alliant",
        ADO_PAT: "fake",
        ADO_WORKSPACE_DIR: ws,
        ADO_TEMPLATE_DIR: ws,
      },
    });
    const dbHandle = openDb({ workspaceDir: ws, path: ":memory:" });
    dbHandles.push(dbHandle);
    const adoClient = clientWith(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const handle = buildAppHandle({ config, dbHandle, staticRoot: null, adoClient });
    const res = await handle.fastify.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as HealthReport;
    expect(body.ado?.auth).toBe("failed");
    expect(body.app.status).toBe("failed");
    await handle.fastify.close();
  });
});
