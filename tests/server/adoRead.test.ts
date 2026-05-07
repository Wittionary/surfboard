import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AdoClient,
  AdoError,
  getDirectChildren,
  getDirectChildrenIds,
  getUpdates,
  getWorkItem,
  getWorkItems,
  isDeletedWorkItem,
} from "../../src/server/adoClient.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/ado");
function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(url), init))) as typeof fetch,
  });
}

describe("getWorkItem", () => {
  test("fetches by id with $expand=Relations by default", async () => {
    let captured = "";
    const client = clientWith((url) => {
      captured = url;
      return new Response(fixture("workitem-221835.json"), { status: 200 });
    });
    const item = await getWorkItem(client, 221835);
    expect(item.id).toBe(221835);
    expect(item.rev).toBe(12);
    expect(item.fields["System.Title"]).toBe("Surfboard sandbox parent");
    expect(captured).toContain("/wit/workitems/221835");
    expect(captured).toContain("expand=Relations");
  });

  test("propagates 404 as AdoError", async () => {
    const client = clientWith(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    let caught: unknown;
    try {
      await getWorkItem(client, 99999999);
    } catch (e) {
      caught = e;
    }
    expect((caught as AdoError).status).toBe(404);
  });
});

describe("getWorkItems / getDirectChildren", () => {
  test("getDirectChildrenIds runs WIQL and returns ids", async () => {
    const client = clientWith((url) => {
      if (url.includes("/wit/wiql")) {
        return new Response(fixture("wiql-children-221835.json"), { status: 200 });
      }
      return new Response("not mocked", { status: 404 });
    });
    const ids = await getDirectChildrenIds(client, 221835);
    expect(ids).toEqual([221836, 221837]);
  });

  test("getDirectChildren chains WIQL + batch fetch", async () => {
    const client = clientWith((url) => {
      if (url.includes("/wit/wiql")) {
        return new Response(fixture("wiql-children-221835.json"), { status: 200 });
      }
      if (url.includes("/wit/workitems")) {
        return new Response(fixture("workitems-batch-221836-221837.json"), { status: 200 });
      }
      return new Response("not mocked", { status: 404 });
    });
    const children = await getDirectChildren(client, 221835);
    expect(children.length).toBe(2);
    expect(children.map((c) => c.id).sort()).toEqual([221836, 221837]);
    expect(children.find((c) => c.id === 221836)?.fields["System.Title"]).toBe("Sandbox PBI A");
  });

  test("getWorkItems returns empty array for empty input without calling fetch", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const items = await getWorkItems(client, []);
    expect(items).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("getUpdates", () => {
  test("returns the updates list with field deltas", async () => {
    const client = clientWith((url) => {
      if (url.includes("/wit/workitems/221835/updates")) {
        return new Response(fixture("updates-221835.json"), { status: 200 });
      }
      return new Response("not mocked", { status: 404 });
    });
    const updates = await getUpdates(client, 221835);
    expect(updates.length).toBe(2);
    expect(updates[1]?.rev).toBe(12);
    expect(updates[0]?.fields?.["System.Title"]?.newValue).toBe("Surfboard sandbox parent");
  });
});

describe("isDeletedWorkItem", () => {
  test("returns true when System.IsDeleted is set", () => {
    expect(
      isDeletedWorkItem({
        id: 1,
        rev: 1,
        fields: { "System.IsDeleted": true },
      }),
    ).toBe(true);
  });

  test("returns false for normal items", () => {
    expect(
      isDeletedWorkItem({ id: 1, rev: 1, fields: { "System.Title": "x" } }),
    ).toBe(false);
  });

  test("treats null/undefined as deleted", () => {
    expect(isDeletedWorkItem(null)).toBe(true);
    expect(isDeletedWorkItem(undefined)).toBe(true);
  });
});
