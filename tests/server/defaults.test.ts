import { describe, expect, test } from "bun:test";
import { applyDefaults, omitDefaults } from "../../src/server/defaults.ts";
import type { WorkItemDefaults } from "../../src/server/templateStore.ts";
import type { LocalWorkItem } from "../../src/shared/types.ts";

function pbi(overrides: Partial<LocalWorkItem["spec"]> = {}): LocalWorkItem {
  return {
    apiVersion: "surfboard.ado/v1",
    kind: "PBI",
    metadata: { localId: "pbi-1" },
    spec: {
      fields: { "System.Title": "Hello" },
      ...overrides,
    },
    yamlPath: "/tmp/pbi.yaml",
    yamlDocumentIndex: 0,
  };
}

const defaults: WorkItemDefaults = {
  global: {
    tags: ["team-default"],
    fields: { "System.AreaPath": "Alliant", "System.IterationPath": "Sprint 1" },
  },
  kinds: {
    PBI: {
      fields: {
        "Custom.Product": "MyProduct",
        "Microsoft.VSTS.Common.Priority": 2,
        "System.IterationPath": "Sprint 9", // overrides global
      },
    },
  },
  source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
};

describe("applyDefaults", () => {
  test("inherits global and kind-specific fields when omitted", () => {
    const effective = applyDefaults(pbi(), defaults);
    expect(effective.spec.fields["System.AreaPath"]).toBe("Alliant");
    expect(effective.spec.fields["Custom.Product"]).toBe("MyProduct");
    expect(effective.spec.fields["Microsoft.VSTS.Common.Priority"]).toBe(2);
  });

  test("authored value overrides global or kind default", () => {
    const item = pbi({ fields: { "System.Title": "x", "System.AreaPath": "Other" } });
    const effective = applyDefaults(item, defaults);
    expect(effective.spec.fields["System.AreaPath"]).toBe("Other");
  });

  test("kind default overrides global default of the same key", () => {
    const effective = applyDefaults(pbi(), defaults);
    expect(effective.spec.fields["System.IterationPath"]).toBe("Sprint 9");
  });

  test("authored tags replace default tags as a whole", () => {
    const item = pbi({ tags: ["mine"], fields: { "System.Title": "x" } });
    const effective = applyDefaults(item, defaults);
    expect(effective.spec.tags).toEqual(["mine"]);
  });

  test("default tags appear in effective item when authored item omits tags", () => {
    const effective = applyDefaults(pbi(), defaults);
    expect(effective.spec.tags).toEqual(["team-default"]);
  });

  test("preserves apiVersion, kind, yamlPath, yamlDocumentIndex from authored item", () => {
    const item = pbi();
    const effective = applyDefaults(item, defaults);
    expect(effective.apiVersion).toBe("surfboard.ado/v1");
    expect(effective.kind).toBe("PBI");
    expect(effective.yamlPath).toBe(item.yamlPath);
    expect(effective.yamlDocumentIndex).toBe(item.yamlDocumentIndex);
  });

  test("does not mutate the authored item", () => {
    const item = pbi();
    const snapshot = JSON.parse(JSON.stringify(item));
    applyDefaults(item, defaults);
    expect(JSON.parse(JSON.stringify(item))).toEqual(snapshot);
  });

  test("returns the input when defaults is undefined", () => {
    const item = pbi();
    expect(applyDefaults(item, undefined)).toBe(item);
  });

  test("metadata keys from defaults appear unless authored item supplies them", () => {
    const withMetaDefaults: WorkItemDefaults = {
      global: { metadata: { owner: "alpha" } as Record<string, unknown> },
      source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
    };
    const effective = applyDefaults(pbi(), withMetaDefaults);
    expect((effective.metadata as Record<string, unknown>).owner).toBe("alpha");
  });

  test("does not let defaults overwrite metadata.localId or metadata.adoId", () => {
    const withMetaDefaults: WorkItemDefaults = {
      global: {
        metadata: { localId: "default-id", adoId: 999 } as Record<string, unknown>,
      },
      source: { path: "/tmp/defaults.yaml", documentIndex: 0 },
    };
    const item: LocalWorkItem = {
      ...pbi(),
      metadata: { localId: "pbi-1", adoId: 5 },
    };
    const effective = applyDefaults(item, withMetaDefaults);
    expect(effective.metadata.localId).toBe("pbi-1");
    expect(effective.metadata.adoId).toBe(5);
  });
});

describe("omitDefaults", () => {
  test("strips field whose value matches an applicable default", () => {
    const item = pbi({
      fields: {
        "System.Title": "x",
        "System.AreaPath": "Alliant",
        "Custom.Product": "MyProduct",
      },
    });
    const stripped = omitDefaults(item, defaults);
    expect(stripped.spec.fields["System.AreaPath"]).toBeUndefined();
    expect(stripped.spec.fields["Custom.Product"]).toBeUndefined();
    expect(stripped.spec.fields["System.Title"]).toBe("x");
  });

  test("keeps a field whose value differs from the default", () => {
    const item = pbi({
      fields: { "System.Title": "x", "System.AreaPath": "Other" },
    });
    const stripped = omitDefaults(item, defaults);
    expect(stripped.spec.fields["System.AreaPath"]).toBe("Other");
  });

  test("omits tags when the full tag list matches the applicable default tags", () => {
    const item = pbi({
      tags: ["team-default"],
      fields: { "System.Title": "x" },
    });
    const stripped = omitDefaults(item, defaults);
    expect(stripped.spec.tags).toBeUndefined();
  });

  test("keeps tags when they differ from defaults", () => {
    const item = pbi({
      tags: ["team-default", "extra"],
      fields: { "System.Title": "x" },
    });
    const stripped = omitDefaults(item, defaults);
    expect(stripped.spec.tags).toEqual(["team-default", "extra"]);
  });
});
