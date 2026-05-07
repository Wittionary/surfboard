import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const fixtureRoot = resolve(projectRoot, "tests/fixtures");
const workspaceRoot = resolve(projectRoot, "workspace");

const SAFE_ADO_PARENT = "221835";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (!existsSync(current)) continue;
    const stat = statSync(current);
    if (!stat.isDirectory()) {
      out.push(current);
      continue;
    }
    for (const name of readdirSync(current)) {
      stack.push(join(current, name));
    }
  }
  return out;
}

describe("fixture conventions", () => {
  test("workspace skeleton exists with templates and workitems", () => {
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(join(workspaceRoot, "templates"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "workitems"))).toBe(true);
  });

  test("workspace-empty fixture exists", () => {
    const empty = join(fixtureRoot, "workspace-empty");
    expect(existsSync(empty)).toBe(true);
    expect(existsSync(join(empty, "templates"))).toBe(true);
    expect(existsSync(join(empty, "workitems"))).toBe(true);
  });

  test("fixture README documents categories and safe ADO ID rule", () => {
    const readme = readFileSync(join(fixtureRoot, "README.md"), "utf8");
    expect(readme).toContain("workspace-empty");
    expect(readme).toContain(SAFE_ADO_PARENT);
    expect(readme).toContain("Hard rules");
  });

  test("no fixture file references a non-safe ADO ID as a mutation target", () => {
    // The check is shape-based: we only fail if a fixture explicitly tags an ID
    // as a mutation target via a `mutates:` or `mutateAdoId:` key. This catches
    // accidental encoding of real production targets without false-positive
    // banning of arbitrary numbers (revisions, counts, etc.).
    const files = listFilesRecursive(fixtureRoot).filter(
      (p) => p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".json"),
    );
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const matches = [...text.matchAll(/\b(?:mutates|mutateAdoId|mutate_ado_id):\s*([0-9]+)/g)];
      for (const match of matches) {
        const id = match[1];
        expect(id, `${path} declares mutation of ADO ID ${id}; only ${SAFE_ADO_PARENT} or app-created children are permitted`).toBe(
          SAFE_ADO_PARENT,
        );
      }
    }
  });

  test("no fixture file contains a likely real PAT or auth header", () => {
    const files = listFilesRecursive(fixtureRoot).filter(
      (p) => !p.endsWith(".gitkeep") && !p.endsWith("README.md"),
    );
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      // ADO PATs are 52- to 84-char base64url-ish strings. Reject only when paired
      // with an `authorization` or `pat` label to avoid false positives on hashes.
      const labeled = /(?:authorization|pat|x-ms-authentication)\s*[:=]\s*["']?[A-Za-z0-9_=\/+\-]{40,}/i;
      expect(labeled.test(text), `${path} appears to contain a credential value`).toBe(false);
    }
  });
});
