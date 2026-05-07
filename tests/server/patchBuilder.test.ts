import { describe, expect, test } from "bun:test";
import type { AdoWorkItem } from "../../src/server/adoClient.ts";
import {
  buildCreatePatch,
  buildUpdatePatch,
  detectReparent,
  workItemUrl,
} from "../../src/server/patchBuilder.ts";
import type { LocalWorkItem } from "../../src/shared/types.ts";

const PARENT_URL = "https://dev.azure.com/goalliant/_apis/wit/workItems/221835";

function pbi(over: Partial<LocalWorkItem["spec"]> = {}): LocalWorkItem {
  return {
    apiVersion: "surfboard.ado/v1",
    kind: "PBI",
    metadata: { localId: "p", adoId: 100 },
    spec: {
      parent: { adoId: 221835 },
      fields: { "System.Title": "Hello" },
      ...over,
    },
    yamlPath: "/x.yaml",
    yamlDocumentIndex: 0,
  };
}

describe("buildCreatePatch", () => {
  test("emits add ops for each field", () => {
    const ops = buildCreatePatch({ item: pbi(), parentUrl: PARENT_URL });
    const fieldOps = ops.filter((o) => o.path.startsWith("/fields"));
    expect(fieldOps.length).toBeGreaterThan(0);
    expect(fieldOps[0]?.op).toBe("add");
  });

  test("includes a Hierarchy-Reverse relation when parentUrl is provided", () => {
    const ops = buildCreatePatch({ item: pbi(), parentUrl: PARENT_URL });
    const rel = ops.find((o) => o.path === "/relations/-");
    expect(rel).toBeDefined();
    const value = rel?.value as { rel: string; url: string };
    expect(value.rel).toBe("System.LinkTypes.Hierarchy-Reverse");
    expect(value.url).toBe(PARENT_URL);
  });

  test("omits parent relation for Epic / when parentUrl missing", () => {
    const epic: LocalWorkItem = {
      apiVersion: "surfboard.ado/v1",
      kind: "Epic",
      metadata: { localId: "e" },
      spec: { fields: { "System.Title": "E" } },
      yamlPath: "/e.yaml",
      yamlDocumentIndex: 0,
    };
    const ops = buildCreatePatch({ item: epic });
    expect(ops.some((o) => o.path === "/relations/-")).toBe(false);
  });

  test("serializes tags to semicolon-space form", () => {
    const ops = buildCreatePatch({
      item: pbi({ tags: ["alpha", "beta"], fields: { "System.Title": "T" } }),
      parentUrl: PARENT_URL,
    });
    const tagOp = ops.find((o) => o.path === "/fields/System.Tags");
    expect(tagOp?.value).toBe("alpha; beta");
  });
});

describe("buildUpdatePatch", () => {
  const remote: AdoWorkItem = {
    id: 100,
    rev: 5,
    fields: {
      "System.WorkItemType": "Product Backlog Item",
      "System.Title": "Old",
      "System.Tags": "old; tag",
      "System.Parent": 221835,
    },
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: PARENT_URL },
    ],
  };

  test("starts with a /rev test op equal to cachedRev", () => {
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "New" } }),
      cachedRev: 5,
      remote,
    });
    expect(ops[0]).toEqual({ op: "test", path: "/rev", value: 5 });
  });

  test("emits replace ops for current fields", () => {
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "New" } }),
      cachedRev: 5,
      remote,
    });
    const titleOp = ops.find((o) => o.path === "/fields/System.Title");
    expect(titleOp?.op).toBe("replace");
    expect(titleOp?.value).toBe("New");
  });

  test("clears tags when local has none and remote had tags", () => {
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "T" } }),
      cachedRev: 5,
      remote,
    });
    const tagOp = ops.find((o) => o.path === "/fields/System.Tags");
    expect(tagOp?.op).toBe("replace");
    expect(tagOp?.value).toBe("");
  });

  test("does not emit a tag op when neither local nor remote has tags", () => {
    const remoteNoTags: AdoWorkItem = { ...remote, fields: { ...remote.fields, "System.Tags": "" } };
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "T" } }),
      cachedRev: 5,
      remote: remoteNoTags,
    });
    expect(ops.some((o) => o.path === "/fields/System.Tags")).toBe(false);
  });

  test("emits remove + add for a parent change with the correct relation index", () => {
    const newParent = "https://dev.azure.com/goalliant/_apis/wit/workItems/300000";
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "T" }, parent: { adoId: 300000 } }),
      cachedRev: 5,
      remote,
      newParentUrl: newParent,
    });
    const removeOp = ops.find((o) => o.op === "remove" && o.path.startsWith("/relations/"));
    expect(removeOp?.path).toBe("/relations/0");
    const addOp = ops.find((o) => o.op === "add" && o.path === "/relations/-");
    expect(addOp).toBeDefined();
    const value = addOp?.value as { rel: string; url: string };
    expect(value.url).toBe(newParent);
  });

  test("does not modify relations when newParentUrl is not provided", () => {
    const ops = buildUpdatePatch({
      item: pbi({ fields: { "System.Title": "T" } }),
      cachedRev: 5,
      remote,
    });
    expect(ops.some((o) => o.path.startsWith("/relations/"))).toBe(false);
  });
});

describe("detectReparent", () => {
  test("returns true when local parent.adoId differs from remote parent", () => {
    const remote: AdoWorkItem = {
      id: 1,
      rev: 1,
      fields: { "System.Parent": 100 },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: workItemUrl("o", 100) }],
    };
    const local = pbi({ parent: { adoId: 200 }, fields: { "System.Title": "T" } });
    expect(detectReparent(local, remote)).toBe(true);
  });

  test("returns false when local parent matches remote parent", () => {
    const remote: AdoWorkItem = {
      id: 1,
      rev: 1,
      fields: { "System.Parent": 100 },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: workItemUrl("o", 100) }],
    };
    const local = pbi({ parent: { adoId: 100 }, fields: { "System.Title": "T" } });
    expect(detectReparent(local, remote)).toBe(false);
  });

  test("returns false when local has no parent.adoId", () => {
    const remote: AdoWorkItem = {
      id: 1,
      rev: 1,
      fields: { "System.Parent": 100 },
    };
    const local = pbi({ fields: { "System.Title": "T" } });
    delete local.spec.parent;
    expect(detectReparent(local, remote)).toBe(false);
  });
});
