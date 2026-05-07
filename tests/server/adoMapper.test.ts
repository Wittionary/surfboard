import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdoWorkItem } from "../../src/server/adoClient.ts";
import {
  mapAdoTagsToSpec,
  mapAdoToLocal,
  mapSpecTagsToAdo,
  parseAdoIdFromUrl,
} from "../../src/server/adoMapper.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/ado");
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as T;
}

const PATH_OPTS = { yamlPath: "/tmp/x.yaml", yamlDocumentIndex: 0 };

describe("mapAdoToLocal", () => {
  test("maps the parent fixture into a Feature with parent relation", () => {
    const item = loadFixture<AdoWorkItem>("workitem-221835.json");
    const local = mapAdoToLocal(item, PATH_OPTS);
    expect(local.kind).toBe("Feature");
    expect(local.metadata.adoId).toBe(221835);
    expect(local.spec.parent?.adoId).toBe(200000);
    expect(local.spec.fields["System.Title"]).toBe("Surfboard sandbox parent");
    expect(local.spec.fields["System.Rev"]).toBeUndefined();
    expect(local.spec.fields["System.Tags"]).toBeUndefined();
    expect(local.spec.tags).toEqual(["sandbox", "surfboard"]);
  });

  test("strips server-managed and bookkeeping fields", () => {
    const item: AdoWorkItem = {
      id: 1,
      rev: 1,
      fields: {
        "System.Id": 1,
        "System.WorkItemType": "PBI",
        "System.Title": "T",
        "System.ChangedBy": { displayName: "x" },
        "System.AreaPath": "Alliant",
        "System.IterationPath": "Alliant",
      },
    };
    const local = mapAdoToLocal(item, PATH_OPTS);
    expect(local.spec.fields["System.Title"]).toBe("T");
    expect(local.spec.fields["System.ChangedBy"]).toBeUndefined();
    expect(local.spec.fields["System.Id"]).toBeUndefined();
    expect(local.spec.fields["System.AreaPath"]).toBe("Alliant");
  });

  test("Epic has no parent and no spec.parent key", () => {
    const item: AdoWorkItem = {
      id: 10,
      rev: 1,
      fields: { "System.WorkItemType": "Epic", "System.Title": "E" },
    };
    const local = mapAdoToLocal(item, PATH_OPTS);
    expect(local.kind).toBe("Epic");
    expect(local.spec.parent).toBeUndefined();
  });

  test("uses System.Parent over relations when present", () => {
    const item: AdoWorkItem = {
      id: 20,
      rev: 1,
      fields: {
        "System.WorkItemType": "Task",
        "System.Title": "T",
        "System.Parent": 18,
      },
      relations: [
        {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: "https://dev.azure.com/org/_apis/wit/workItems/19",
        },
      ],
    };
    const local = mapAdoToLocal(item, PATH_OPTS);
    expect(local.spec.parent?.adoId).toBe(18);
  });

  test("falls back to Hierarchy-Reverse relation when System.Parent is absent", () => {
    const item: AdoWorkItem = {
      id: 30,
      rev: 1,
      fields: { "System.WorkItemType": "Task", "System.Title": "T" },
      relations: [
        {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: "https://dev.azure.com/org/_apis/wit/workItems/19",
        },
      ],
    };
    const local = mapAdoToLocal(item, PATH_OPTS);
    expect(local.spec.parent?.adoId).toBe(19);
  });

  test("populates parent.localId when localIdByAdoId is provided", () => {
    const item: AdoWorkItem = {
      id: 40,
      rev: 1,
      fields: {
        "System.WorkItemType": "PBI",
        "System.Title": "P",
        "System.Parent": 7,
      },
    };
    const local = mapAdoToLocal(item, {
      ...PATH_OPTS,
      localIdByAdoId: new Map([[7, "feature-known"]]),
    });
    expect(local.spec.parent?.localId).toBe("feature-known");
    expect(local.spec.parent?.adoId).toBe(7);
  });

  test("Product Backlog Item maps to PBI", () => {
    const item: AdoWorkItem = {
      id: 50,
      rev: 1,
      fields: { "System.WorkItemType": "Product Backlog Item", "System.Title": "P" },
    };
    expect(mapAdoToLocal(item, PATH_OPTS).kind).toBe("PBI");
  });

  test("Enabler maps to Enabler kind", () => {
    const item: AdoWorkItem = {
      id: 60,
      rev: 1,
      fields: { "System.WorkItemType": "Enabler", "System.Title": "E" },
    };
    expect(mapAdoToLocal(item, PATH_OPTS).kind).toBe("Enabler");
  });

  test("Task maps to Task kind", () => {
    const item: AdoWorkItem = {
      id: 70,
      rev: 1,
      fields: { "System.WorkItemType": "Task", "System.Title": "T" },
    };
    expect(mapAdoToLocal(item, PATH_OPTS).kind).toBe("Task");
  });

  test("throws for unknown work item type", () => {
    const item: AdoWorkItem = {
      id: 80,
      rev: 1,
      fields: { "System.WorkItemType": "Bug", "System.Title": "B" },
    };
    expect(() => mapAdoToLocal(item, PATH_OPTS)).toThrow();
  });

  test("default localId is kind-id derived", () => {
    const item: AdoWorkItem = {
      id: 90,
      rev: 1,
      fields: { "System.WorkItemType": "PBI", "System.Title": "P" },
    };
    expect(mapAdoToLocal(item, PATH_OPTS).metadata.localId).toBe("pbi-90");
  });

  test("uses cached localId when provided", () => {
    const item: AdoWorkItem = {
      id: 91,
      rev: 1,
      fields: { "System.WorkItemType": "PBI", "System.Title": "P" },
    };
    const local = mapAdoToLocal(item, {
      ...PATH_OPTS,
      localIdByAdoId: new Map([[91, "pbi-cached-name"]]),
    });
    expect(local.metadata.localId).toBe("pbi-cached-name");
  });
});

describe("tag conversion", () => {
  test("mapAdoTagsToSpec splits semicolons and trims whitespace", () => {
    expect(mapAdoTagsToSpec("alpha; beta;  gamma  ")).toEqual(["alpha", "beta", "gamma"]);
  });

  test("mapAdoTagsToSpec returns undefined for empty/non-string", () => {
    expect(mapAdoTagsToSpec("")).toBeUndefined();
    expect(mapAdoTagsToSpec(undefined)).toBeUndefined();
    expect(mapAdoTagsToSpec(null)).toBeUndefined();
  });

  test("mapSpecTagsToAdo joins with semicolon-space and dedupes", () => {
    expect(mapSpecTagsToAdo(["a", "b", "a"])).toBe("a; b");
  });

  test("mapSpecTagsToAdo returns undefined for empty input", () => {
    expect(mapSpecTagsToAdo(undefined)).toBeUndefined();
    expect(mapSpecTagsToAdo([])).toBeUndefined();
    expect(mapSpecTagsToAdo([" "])).toBeUndefined();
  });
});

describe("parseAdoIdFromUrl", () => {
  test("parses standard relation URL", () => {
    expect(parseAdoIdFromUrl("https://dev.azure.com/org/_apis/wit/workItems/12345")).toBe(12345);
  });

  test("parses URL with trailing slash", () => {
    expect(parseAdoIdFromUrl("https://dev.azure.com/org/_apis/wit/workItems/12345/")).toBe(12345);
  });

  test("returns null for unparseable URLs", () => {
    expect(parseAdoIdFromUrl("https://dev.azure.com/org/_apis/wit/foo/12345")).toBeNull();
  });
});
