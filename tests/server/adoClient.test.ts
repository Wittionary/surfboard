import { describe, expect, test } from "bun:test";
import { AdoClient, AdoError, redactSecrets } from "../../src/server/adoClient.ts";

const SECRET_PAT = "fake-pat-1234567890ABCDEF";

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
}

function client(fetchImpl: typeof fetch): AdoClient {
  return new AdoClient({
    organization: "goalliant",
    project: "Alliant",
    apiVersion: "7.1",
    pat: SECRET_PAT,
    fetchImpl,
  });
}

describe("AdoClient URL construction", () => {
  test("project-scoped GET includes org, project, api-version, and path", async () => {
    let captured = "";
    const c = client(
      makeFetch((url) => {
        captured = url;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await c.getJson("wit/workitems/221835");
    expect(captured).toContain("dev.azure.com");
    expect(captured).toContain("/goalliant/Alliant/_apis/wit/workitems/221835");
    expect(captured).toContain("api-version=7.1");
  });

  test("query parameters are appended", async () => {
    let captured = "";
    const c = client(
      makeFetch((url) => {
        captured = url;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.getJson("wit/workitems", { query: { ids: "1,2,3", $expand: "Relations" } });
    expect(captured).toContain("ids=1%2C2%2C3");
    expect(captured).toContain("%24expand=Relations");
  });

  test("undefined query values are omitted", async () => {
    let captured = "";
    const c = client(
      makeFetch((url) => {
        captured = url;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.getJson("wit/workitems", { query: { id: 1, omit: undefined } });
    expect(captured).not.toContain("omit=");
  });

  test("orgRequest path skips the project segment", async () => {
    let captured = "";
    const c = client(
      makeFetch((url) => {
        captured = url;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.getJsonOrg("projects");
    expect(captured).toContain("/goalliant/_apis/projects");
    expect(captured).not.toContain("/Alliant/");
  });
});

describe("AdoClient auth and headers", () => {
  test("sends Authorization: Basic with base64(:PAT)", async () => {
    let captured: Record<string, string> | undefined;
    const c = client(
      makeFetch((_url, init) => {
        captured = init?.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.getJson("wit/workitems/1");
    expect(captured?.Authorization).toBeDefined();
    expect(captured?.Authorization).toMatch(/^Basic /);
    const expected = "Basic " + Buffer.from(`:${SECRET_PAT}`).toString("base64");
    expect(captured?.Authorization).toBe(expected);
  });

  test("PATCH sends application/json-patch+json", async () => {
    let captured: Record<string, string> | undefined;
    const c = client(
      makeFetch((_url, init) => {
        captured = init?.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.patchJson("wit/workitems/1", [{ op: "test", path: "/rev", value: 1 }]);
    expect(captured?.["Content-Type"]).toBe("application/json-patch+json");
  });

  test("POST sends application/json", async () => {
    let captured: Record<string, string> | undefined;
    const c = client(
      makeFetch((_url, init) => {
        captured = init?.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }),
    );
    await c.postJson("wit/wiql", { query: "SELECT [System.Id] FROM WorkItems" });
    expect(captured?.["Content-Type"]).toBe("application/json");
  });
});

describe("AdoClient errors", () => {
  test("non-2xx responses throw AdoError with status and statusText", async () => {
    const c = client(
      makeFetch(() => new Response("not found", { status: 404, statusText: "Not Found" })),
    );
    let caught: unknown;
    try {
      await c.getJson("wit/workitems/missing");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdoError);
    expect((caught as AdoError).status).toBe(404);
    expect((caught as AdoError).statusText).toBe("Not Found");
  });

  test("errors do not expose the PAT", async () => {
    const c = client(
      makeFetch(() => new Response(`auth failed using ${SECRET_PAT}`, { status: 401, statusText: "Unauthorized" })),
    );
    try {
      await c.getJson("x");
    } catch (err) {
      const text = (err as Error).message;
      expect(text).not.toContain(SECRET_PAT);
      expect(text).toContain("[REDACTED_PAT]");
    }
  });

  test("network failures become AdoError with status=0", async () => {
    const c = client(
      makeFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    let caught: unknown;
    try {
      await c.getJson("x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdoError);
    expect((caught as AdoError).status).toBe(0);
  });

  test("204 No Content returns undefined", async () => {
    const c = client(makeFetch(() => new Response(null, { status: 204 })));
    const result = await c.getJson<string | undefined>("x");
    expect(result).toBeUndefined();
  });
});

describe("AdoClient construction", () => {
  test("throws when PAT, organization, or project is missing", () => {
    expect(
      () =>
        new AdoClient({ organization: "", project: "p", apiVersion: "7.1", pat: "x" }),
    ).toThrow();
    expect(
      () =>
        new AdoClient({ organization: "o", project: "", apiVersion: "7.1", pat: "x" }),
    ).toThrow();
    expect(
      () =>
        new AdoClient({ organization: "o", project: "p", apiVersion: "7.1", pat: "" }),
    ).toThrow();
  });
});

describe("redactSecrets", () => {
  test("replaces literal PAT and Basic auth values", () => {
    const out = redactSecrets(`token=${SECRET_PAT} Authorization: Basic dGVzdA==`, SECRET_PAT);
    expect(out).not.toContain(SECRET_PAT);
    expect(out).toContain("[REDACTED_PAT]");
    expect(out).toContain("Basic [REDACTED]");
  });

  test("returns input unchanged when PAT is empty", () => {
    expect(redactSecrets("nothing", "")).toBe("nothing");
  });
});
