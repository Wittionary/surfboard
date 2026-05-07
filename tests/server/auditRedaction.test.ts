import { afterEach, describe, expect, test } from "bun:test";
import {
  getAuditByLocalId,
  getRecentAudit,
  redact,
  writeAuditEntry,
} from "../../src/server/audit.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";

const dbHandles: DbHandle[] = [];

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
});

const SECRET = "fake-pat-1234567890ABCDEF";

describe("redact", () => {
  test("strips literal PAT and Basic auth header", () => {
    const out = redact(`token=${SECRET} Authorization: Basic dGVzdA==`, SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Basic dGVzdA==");
    expect(out).toContain("[REDACTED_PAT]");
    expect(out).toContain("[REDACTED_AUTH]");
  });

  test("returns input unchanged when no pat and no auth header", () => {
    expect(redact("hello world")).toBe("hello world");
  });

  test("redacts X-MS-Authentication header values", () => {
    expect(redact("X-MS-Authentication: somevalue123==")).not.toContain("somevalue123");
  });

  test("redacts when only literal token is present (no auth header keyword)", () => {
    const out = redact(`token=${SECRET}`, SECRET);
    expect(out).not.toContain(SECRET);
  });
});

describe("writeAuditEntry", () => {
  test("scrubs PAT from request, response, and error messages on insert", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);

    writeAuditEntry(
      handle.db,
      {
        operationId: "op-1",
        action: "fail",
        success: false,
        errorMessage: `auth failed using ${SECRET}`,
        requestSummary: { headers: { Authorization: `Basic ${Buffer.from(`:${SECRET}`).toString("base64")}` } },
        responseSummary: `body contained ${SECRET}`,
        localId: "p",
      },
      { pat: SECRET },
    );

    const row = getRecentAudit(handle.db, 1)[0];
    expect(row).toBeDefined();
    const text = JSON.stringify(row);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]+/);
  });

  test("retains structured before/after rev and changed value summaries", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);

    writeAuditEntry(handle.db, {
      operationId: "op-2",
      action: "update",
      success: true,
      localId: "feature-a",
      adoId: 100,
      workItemType: "Feature",
      yamlPath: "/ws/feature-a.yaml",
      beforeRev: 5,
      afterRev: 6,
      beforeHash: "h1",
      afterHash: "h2",
      requestSummary: {
        patch: [
          { op: "test", path: "/rev", value: 5 },
          { op: "replace", path: "/fields/System.Title", value: "New" },
        ],
      },
      responseSummary: { rev: 6 },
    });
    const row = getRecentAudit(handle.db, 1)[0];
    expect(row?.localId).toBe("feature-a");
    expect(row?.beforeRev).toBe(5);
    expect(row?.afterRev).toBe(6);
    expect(row?.success).toBe(true);
    const req = row?.requestSummary as { patch?: unknown[] } | null;
    expect(Array.isArray(req?.patch)).toBe(true);
  });
});

describe("audit query helpers", () => {
  test("getAuditByLocalId returns rows for that id only", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);

    writeAuditEntry(handle.db, { operationId: "o", action: "create", success: true, localId: "a" });
    writeAuditEntry(handle.db, { operationId: "o", action: "create", success: true, localId: "b" });
    writeAuditEntry(handle.db, { operationId: "o", action: "update", success: true, localId: "a" });

    const aRows = getAuditByLocalId(handle.db, "a");
    expect(aRows.length).toBe(2);
    expect(aRows.every((r) => r.localId === "a")).toBe(true);
  });

  test("limit clamps high values and rejects zero/negative", () => {
    const handle = openDb({ workspaceDir: "x", path: ":memory:" });
    dbHandles.push(handle);
    for (let i = 0; i < 10; i += 1) {
      writeAuditEntry(handle.db, { operationId: `o${i}`, action: "skip", success: true });
    }
    expect(getRecentAudit(handle.db, 0).length).toBe(1);
    expect(getRecentAudit(handle.db, 9999).length).toBe(10);
  });
});
