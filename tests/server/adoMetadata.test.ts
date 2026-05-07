import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import {
  discoverAdoMetadata,
  loadMetadataSnapshot,
  matchAdoType,
  saveMetadataSnapshot,
} from "../../src/server/adoMetadata.ts";
import { openDb, type DbHandle } from "../../src/server/db.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/ado");
function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const dbHandles: DbHandle[] = [];

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
});

function clientWith(routes: Record<string, string | { status: number; body?: string }>): AdoClient {
  // Sort by descending key length so more specific patterns win.
  const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const fetchImpl = ((url: RequestInfo | URL): Promise<Response> => {
    const u = String(url);
    for (const [pattern, response] of sorted) {
      if (u.includes(pattern)) {
        if (typeof response === "string") {
          return Promise.resolve(new Response(response, { status: 200 }));
        }
        return Promise.resolve(new Response(response.body ?? "", { status: response.status }));
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "not mocked", url: u }), { status: 404 }));
  }) as typeof fetch;

  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake-pat",
    fetchImpl,
  });
}

describe("discoverAdoMetadata", () => {
  test("collects project, work item types, fields, and states for known kinds", async () => {
    const client = clientWith({
      "/_apis/projects/Alliant": fixture("project-capabilities.json"),
      "/_apis/wit/workitemtypes/Microsoft.VSTS.WorkItemTypes.PBI/states": fixture("states-pbi.json"),
      "/_apis/wit/workitemtypes": fixture("work-item-types.json"),
      "/_apis/wit/fields": fixture("fields.json"),
    });

    const snapshot = await discoverAdoMetadata(client);

    expect(snapshot.project.name).toBe("Alliant");
    expect(snapshot.project.processTemplate?.templateName).toBe("Scrum");
    expect(snapshot.workItemTypes.length).toBe(5);
    expect(snapshot.fields.find((f) => f.referenceName === "System.Title")?.required).toBe(true);
    expect(snapshot.statesByType["Microsoft.VSTS.WorkItemTypes.PBI"]?.length).toBeGreaterThan(0);
    expect(typeof snapshot.fetchedAt).toBe("string");
  });

  test("missing states for a kind do not fail the snapshot", async () => {
    const client = clientWith({
      "/_apis/projects/Alliant": fixture("project-capabilities.json"),
      // Listing endpoint must use a more specific pattern so it does not
      // match the per-type /states endpoints that we want to 500.
      "/_apis/wit/workitemtypes?": fixture("work-item-types.json"),
      "/_apis/wit/fields": fixture("fields.json"),
      "/states?": { status: 500 },
    });

    const snapshot = await discoverAdoMetadata(client);
    expect(snapshot.statesByType["Microsoft.VSTS.WorkItemTypes.PBI"]).toBeUndefined();
    expect(snapshot.workItemTypes.length).toBe(5);
  });
});

describe("matchAdoType", () => {
  const types = JSON.parse(fixture("work-item-types.json")).value;

  test("PBI matches Product Backlog Item by name", () => {
    expect(matchAdoType(types, "PBI")?.referenceName).toBe("Microsoft.VSTS.WorkItemTypes.PBI");
  });

  test("Enabler matches custom Enabler", () => {
    expect(matchAdoType(types, "Enabler")?.referenceName).toBe("Custom.Enabler");
  });

  test("returns undefined when type is absent", () => {
    expect(matchAdoType([], "Task")).toBeUndefined();
  });
});

describe("save / loadMetadataSnapshot", () => {
  test("round-trips through the settings table", async () => {
    const handle = openDb({ workspaceDir: "ignored", path: ":memory:" });
    dbHandles.push(handle);

    const client = clientWith({
      "/_apis/projects/Alliant": fixture("project-capabilities.json"),
      "/_apis/wit/workitemtypes": fixture("work-item-types.json"),
      "/_apis/wit/fields": fixture("fields.json"),
    });
    const snapshot = await discoverAdoMetadata(client);
    saveMetadataSnapshot(handle.db, snapshot);

    const loaded = loadMetadataSnapshot(handle.db);
    expect(loaded?.project.name).toBe("Alliant");
    expect(loaded?.workItemTypes.length).toBe(5);
  });

  test("returns null when no snapshot has been saved", () => {
    const handle = openDb({ workspaceDir: "ignored", path: ":memory:" });
    dbHandles.push(handle);
    expect(loadMetadataSnapshot(handle.db)).toBeNull();
  });
});
