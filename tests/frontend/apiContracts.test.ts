import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ParentViewResponse,
  ScaffoldChildResponse,
  ValidateResponse,
  WorkItemView,
  WorkspaceStatusResponse,
} from "../../src/shared/api.ts";

type FrontendApiTypes = [
  WorkspaceStatusResponse,
  ValidateResponse,
  WorkItemView,
  ParentViewResponse,
  ScaffoldChildResponse,
];

describe("frontend API contracts", () => {
  test("frontend-facing DTOs are available from shared/api", () => {
    const _types: FrontendApiTypes | null = null;
    expect(_types).toBeNull();
  });

  test("frontend modules do not import server route modules", () => {
    const files = [
      resolve(import.meta.dir, "../../src/frontend/apiClient.ts"),
      resolve(import.meta.dir, "../../src/frontend/app.ts"),
      resolve(import.meta.dir, "../../src/frontend/render.ts"),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("../server/");
      expect(source).not.toContain("src/server/");
    }
  });
});
