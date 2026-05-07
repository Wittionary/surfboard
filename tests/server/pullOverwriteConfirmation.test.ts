import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AdoClient } from "../../src/server/adoClient.ts";
import {
  getCachedByAdoId,
  openDb,
  type DbHandle,
} from "../../src/server/db.ts";
import { pullParentAndChildren } from "../../src/server/syncEngine.ts";
import { parseYamlFile } from "../../src/server/yamlStore.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures/ado");
function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const tempDirs: string[] = [];
const dbHandles: DbHandle[] = [];

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "surfboard-confirm-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dbHandles.length > 0) dbHandles.pop()?.close();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function client(routes: Record<string, string | { status: number; body?: string }>): AdoClient {
  const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: "fake",
    fetchImpl: ((url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      for (const [pattern, response] of sorted) {
        if (u.includes(pattern)) {
          if (typeof response === "string") {
            return Promise.resolve(new Response(response, { status: 200 }));
          }
          return Promise.resolve(new Response(response.body ?? "", { status: response.status }));
        }
      }
      return Promise.resolve(new Response("not mocked", { status: 404 }));
    }) as typeof fetch,
  });
}

function rerev(json: string, newRev: number): string {
  const obj = JSON.parse(json);
  if (obj.id !== undefined) {
    obj.rev = newRev;
    if (obj.fields) obj.fields["System.Rev"] = newRev;
  }
  if (Array.isArray(obj.value)) {
    for (const v of obj.value) {
      v.rev = newRev;
      if (v.fields) v.fields["System.Rev"] = newRev;
    }
  }
  return JSON.stringify(obj);
}

function rewriteTitle(json: string, newTitle: string): string {
  const obj = JSON.parse(json);
  if (obj.fields) obj.fields["System.Title"] = newTitle;
  return JSON.stringify(obj);
}

describe("pull overwrite confirmation", () => {
  test("first pull is a clean create; second pull at same rev is skip", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);
    const c = client({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );
    const second = await pullParentAndChildren(
      { client: c, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );
    expect(second.items.every((i) => i.action === "skip")).toBe(true);
  });

  test("requires confirmation when remote diverged after baseline; YAML and last_known stay unchanged", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    // Initial pull at rev 12 / 3 / 5.
    const initial = client({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client: initial, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const cachedBefore = getCachedByAdoId(dbHandle.db, 221835);
    const yamlBefore = readFileSync(
      join(workspaceDir, "workitems", "features", "feature-221835.yaml"),
      "utf8",
    );

    // Second pull: parent rev advanced and title changed remotely.
    const second = client({
      "/wit/workitems/221835?": rerev(
        rewriteTitle(fixture("workitem-221835.json"), "REMOTE OVERWROTE TITLE"),
        99,
      ),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    const result = await pullParentAndChildren(
      { client: second, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const parentItem = result.items.find((i) => i.adoId === 221835);
    expect(parentItem?.status).toBe("requires_confirmation");
    expect(parentItem?.confirmationRequired).toBe("overwrite_yaml");

    // YAML did not change.
    const yamlAfter = readFileSync(
      join(workspaceDir, "workitems", "features", "feature-221835.yaml"),
      "utf8",
    );
    expect(yamlAfter).toBe(yamlBefore);
    expect(yamlAfter).not.toContain("REMOTE OVERWROTE TITLE");

    // last_known_rev/hashes unchanged; remote-observed metadata advanced.
    const cachedAfter = getCachedByAdoId(dbHandle.db, 221835);
    expect(cachedAfter?.lastKnownRev).toBe(cachedBefore?.lastKnownRev);
    expect(cachedAfter?.lastKnownFieldHash).toBe(cachedBefore?.lastKnownFieldHash);
    expect(cachedAfter?.lastKnownRelationHash).toBe(cachedBefore?.lastKnownRelationHash);
    expect(cachedAfter?.lastRemoteRev).toBe(99);
    expect(cachedAfter?.remoteChangedAt).toBeDefined();
    expect(cachedAfter?.syncStatus).toBe("remote_changed");
  });

  test("with an explicit confirmation, YAML is overwritten and baseline advances", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    const initial = client({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client: initial, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const second = client({
      "/wit/workitems/221835?": rerev(
        rewriteTitle(fixture("workitem-221835.json"), "REMOTE OVERWROTE TITLE"),
        99,
      ),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    const yamlPath = join(workspaceDir, "workitems", "features", "feature-221835.yaml");
    const result = await pullParentAndChildren(
      { client: second, db: dbHandle.db, workspaceDir },
      {
        selector: { adoId: 221835 },
        confirmations: [
          {
            adoId: 221835,
            yamlPath,
            yamlDocumentIndex: 0,
            remoteRev: 99,
            confirmed: true,
          },
        ],
      },
    );

    const parentItem = result.items.find((i) => i.adoId === 221835);
    expect(parentItem?.status).toBe("success");
    expect(parentItem?.action).toBe("update");
    expect(parentItem?.afterRev).toBe(99);

    // YAML now contains the new title.
    const docs = parseYamlFile(yamlPath);
    expect(docs[0]?.content?.spec.fields["System.Title"]).toBe("REMOTE OVERWROTE TITLE");

    // Baseline advanced.
    const cached = getCachedByAdoId(dbHandle.db, 221835);
    expect(cached?.lastKnownRev).toBe(99);
    expect(cached?.syncStatus).toBe("synced");
    expect(cached?.remoteChangedAt).toBeUndefined();
  });

  test("declined overwrite + later confirm replays correctly", async () => {
    const workspaceDir = ws();
    const dbHandle = openDb({ workspaceDir, path: ":memory:" });
    dbHandles.push(dbHandle);

    const initial = client({
      "/wit/workitems/221835?": fixture("workitem-221835.json"),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });
    await pullParentAndChildren(
      { client: initial, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );

    const second = client({
      "/wit/workitems/221835?": rerev(
        rewriteTitle(fixture("workitem-221835.json"), "TITLE V2"),
        77,
      ),
      "/wit/wiql": fixture("wiql-children-221835.json"),
      "/wit/workitems?ids=": fixture("workitems-batch-221836-221837.json"),
    });

    // First call: no confirmation → requires_confirmation.
    const decline = await pullParentAndChildren(
      { client: second, db: dbHandle.db, workspaceDir },
      { selector: { adoId: 221835 } },
    );
    expect(decline.items.find((i) => i.adoId === 221835)?.status).toBe("requires_confirmation");

    // Second call with the confirmation → success.
    const yamlPath = join(workspaceDir, "workitems", "features", "feature-221835.yaml");
    const accept = await pullParentAndChildren(
      { client: second, db: dbHandle.db, workspaceDir },
      {
        selector: { adoId: 221835 },
        confirmations: [
          { adoId: 221835, yamlPath, yamlDocumentIndex: 0, remoteRev: 77, confirmed: true },
        ],
      },
    );
    const parent = accept.items.find((i) => i.adoId === 221835);
    expect(parent?.status).toBe("success");
    expect(parent?.action).toBe("update");
  });
});
