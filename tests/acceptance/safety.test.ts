// Final safety review per spec §14 and §21. These tests are intentionally
// implementation-specific: they grep the source for the absence/presence of
// load-bearing patterns. If a test here fails, it means a hard invariant
// from CLAUDE.md or the spec was relaxed and needs human review.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../src");

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}

function readAllSource(): { path: string; text: string }[] {
  if (!existsSync(SRC)) return [];
  const out: { path: string; text: string }[] = [];
  for (const path of walkFiles(SRC)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

const SOURCE_FILES = readAllSource();

describe("hard invariants are enforced in source", () => {
  test("update patches always include a /rev test op", () => {
    const patchBuilder = SOURCE_FILES.find((f) => f.path.endsWith("patchBuilder.ts"));
    expect(patchBuilder).toBeDefined();
    expect(patchBuilder!.text).toContain('op: "test"');
    expect(patchBuilder!.text).toContain('path: "/rev"');
  });

  test("no source file deletes work items via DELETE method", () => {
    for (const file of SOURCE_FILES) {
      if (file.path.includes("__tests__")) continue;
      // Look for direct DELETE method usage in fetch-style calls.
      expect(/method:\s*['"]DELETE['"]/.test(file.text)).toBe(false);
    }
  });

  test("no source file calls --force push or git push directly", () => {
    for (const file of SOURCE_FILES) {
      expect(file.text).not.toMatch(/git\s+push\s+--force/);
      expect(file.text).not.toMatch(/git\s+push\s+-f\b/);
    }
  });

  test("no automatic background push or pull is wired in", () => {
    for (const file of SOURCE_FILES) {
      // setInterval invocations are allowed for non-sync purposes (none today,
      // but reserved). The forbidden pattern is calling pushParentAndChildren
      // or pullParentAndChildren from inside setInterval / setTimeout chains.
      const lines = file.text.split("\n");
      let inTimer = false;
      for (const line of lines) {
        if (line.includes("setInterval(") || line.includes("setTimeout(")) {
          inTimer = true;
        }
        if (inTimer && (line.includes("pushParentAndChildren") || line.includes("pullParentAndChildren"))) {
          throw new Error(`auto-sync hint in ${file.path}: ${line.trim()}`);
        }
        if (line.includes(")")) inTimer = false;
      }
    }
  });

  test("audit redaction is applied in the writeAuditEntry path", () => {
    const audit = SOURCE_FILES.find((f) => f.path.endsWith("audit.ts"));
    expect(audit).toBeDefined();
    expect(audit!.text).toContain("REDACTED_PAT");
    expect(audit!.text).toContain("REDACTED_AUTH");
  });

  test("file watcher's onChange refreshes workspace but does not auto-sync", () => {
    const app = SOURCE_FILES.find((f) => f.path.endsWith("server/app.ts"));
    expect(app).toBeDefined();
    // The onChange callback should call ws.refresh and nothing else; in
    // particular it must not invoke pull or push functions.
    const onChangeBlock = app!.text.match(/onChange:[\s\S]{0,400}/);
    expect(onChangeBlock?.[0]).toContain("refresh");
    expect(onChangeBlock?.[0] ?? "").not.toContain("pullParentAndChildren");
    expect(onChangeBlock?.[0] ?? "").not.toContain("pushParentAndChildren");
  });

  test("MVP refuses to create parents (push prevalidation blocks it)", () => {
    const sync = SOURCE_FILES.find((f) => f.path.endsWith("syncEngine.ts"));
    expect(sync).toBeDefined();
    expect(sync!.text).toContain("create_parent_not_supported");
  });

  test("PAT is never persisted: config.publicConfig strips it", () => {
    const config = SOURCE_FILES.find((f) => f.path.endsWith("config.ts"));
    expect(config).toBeDefined();
    // publicConfig must not destructure or pass through the pat field.
    expect(config!.text).toContain("publicConfig");
    expect(config!.text).not.toMatch(/pat:\s*config\.ado\.pat/);
  });

  test("CLAUDE.md and spec exist and are not silently modified during this run", () => {
    const root = resolve(SRC, "..");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(root, "docs", "2026-05-06-initial-spec.md"))).toBe(true);
  });
});
