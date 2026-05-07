import { describe, expect, test } from "bun:test";
import {
  buildConfirmPopup,
  extractOverwriteRequests,
} from "../../src/frontend/render.ts";
import type { ItemOperationResult, OperationResult } from "../../src/shared/types.ts";

function makeResult(items: ItemOperationResult[]): OperationResult {
  return {
    operationId: "op-test",
    status: "partial_failure",
    summary: { validated: 0, created: 0, updated: 0, pulled: 0, blocked: 0, failed: 0 },
    items,
  };
}

describe("extractOverwriteRequests", () => {
  test("returns one entry per requires_confirmation overwrite item", () => {
    const requests = extractOverwriteRequests(
      makeResult([
        {
          action: "pull",
          status: "requires_confirmation",
          confirmationRequired: "overwrite_yaml",
          adoId: 100,
          remoteRev: 5,
          yamlPath: "/ws/p.yaml",
          yamlDocumentIndex: 0,
          localId: "p",
          workItemType: "PBI",
        },
      ]),
    );
    expect(requests.length).toBe(1);
    expect(requests[0]?.confirmation.adoId).toBe(100);
    expect(requests[0]?.confirmation.remoteRev).toBe(5);
    expect(requests[0]?.confirmation.confirmed).toBe(true);
    expect(requests[0]?.confirmation.yamlPath).toBe("/ws/p.yaml");
  });

  test("ignores items in other states", () => {
    const requests = extractOverwriteRequests(
      makeResult([
        { action: "create", status: "success", adoId: 1 },
        { action: "skip", status: "success", adoId: 2 },
        {
          action: "pull",
          status: "requires_confirmation",
          confirmationRequired: "change_parent", // different confirmation type
          adoId: 3,
          remoteRev: 1,
          yamlPath: "/x.yaml",
        },
      ]),
    );
    expect(requests.length).toBe(0);
  });

  test("skips items missing required confirmation fields", () => {
    const requests = extractOverwriteRequests(
      makeResult([
        {
          action: "pull",
          status: "requires_confirmation",
          confirmationRequired: "overwrite_yaml",
          // missing adoId — cannot construct a valid confirmation
          remoteRev: 5,
          yamlPath: "/x.yaml",
        },
      ]),
    );
    expect(requests.length).toBe(0);
  });
});

describe("buildConfirmPopup", () => {
  test("populates each modal field", () => {
    const popup = buildConfirmPopup({
      action: "pull",
      status: "requires_confirmation",
      confirmationRequired: "overwrite_yaml",
      localId: "pbi-x",
      adoId: 222,
      workItemType: "PBI",
      yamlPath: "/ws/pbis/pbi-x.yaml",
      cachedRev: 4,
      remoteRev: 7,
    });
    expect(popup.title).toBe("Overwrite local YAML?");
    expect(popup.workItemType).toBe("PBI");
    expect(popup.localId).toBe("pbi-x");
    expect(popup.adoId).toBe("222");
    expect(popup.yamlPath).toBe("/ws/pbis/pbi-x.yaml");
    expect(popup.cachedRev).toBe("4");
    expect(popup.remoteRev).toBe("7");
  });

  test("uses placeholders for missing fields", () => {
    const popup = buildConfirmPopup({
      action: "pull",
      status: "requires_confirmation",
      confirmationRequired: "overwrite_yaml",
    });
    expect(popup.localId).toBe("(unknown)");
    expect(popup.adoId).toBe("—");
    expect(popup.cachedRev).toBe("—");
    expect(popup.remoteRev).toBe("—");
  });
});
