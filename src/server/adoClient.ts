// Thin Azure DevOps REST client per spec §11. Builds URLs from config, sends
// PAT auth as HTTP Basic, supports JSON Patch operations, redacts secrets.
//
// Hard rule: the PAT must never appear in error messages, logs, or response
// summaries. The redactSecrets() helper is the single chokepoint.

import { ADO_PATCH_MEDIA_TYPE } from "../shared/constants.ts";

export type AdoClientOptions = {
  organization: string;
  project: string;
  apiVersion: string;
  pat: string;
  /** Custom fetch implementation for testing. */
  fetchImpl?: typeof fetch;
  /** Override the base URL (e.g. for visualstudio.com tenants). Defaults to dev.azure.com. */
  baseUrl?: string;
};

export type AdoErrorShape = {
  status: number;
  statusText: string;
  url: string;
  body?: unknown;
};

export class AdoError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body?: unknown;
  constructor(shape: AdoErrorShape, message?: string) {
    super(message ?? `ADO ${shape.status} ${shape.statusText} for ${shape.url}`);
    this.name = "AdoError";
    this.status = shape.status;
    this.statusText = shape.statusText;
    this.url = shape.url;
    this.body = shape.body;
  }
}

export type AdoRequestOptions = {
  /** Path scoped to org+project (e.g. `wit/workitems/123`). For org-scoped paths use `orgRequest`. */
  query?: Record<string, string | number | boolean | undefined>;
};

export type AdoJsonPatchOp = {
  op: "add" | "remove" | "replace" | "test" | "move" | "copy";
  path: string;
  value?: unknown;
  from?: string;
};

export class AdoClient {
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: AdoClientOptions) {
    if (!options.pat) throw new Error("AdoClient: PAT is required");
    if (!options.organization) throw new Error("AdoClient: organization is required");
    if (!options.project) throw new Error("AdoClient: project is required");
    this.authHeader = "Basic " + Buffer.from(`:${options.pat}`).toString("base64");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://dev.azure.com";
  }

  /** Returns the configured organization name. */
  get organization(): string {
    return this.options.organization;
  }

  /** Returns the configured project name. */
  get project(): string {
    return this.options.project;
  }

  /** Project-scoped GET, parses JSON. */
  async getJson<T>(path: string, opts: AdoRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", this.projectUrl(path, opts.query));
  }

  /** Project-scoped POST with JSON body. */
  async postJson<T>(path: string, body: unknown, opts: AdoRequestOptions = {}): Promise<T> {
    return this.request<T>("POST", this.projectUrl(path, opts.query), {
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  /** Project-scoped PATCH with JSON Patch document. */
  async patchJson<T>(
    path: string,
    patch: readonly AdoJsonPatchOp[],
    opts: AdoRequestOptions = {},
  ): Promise<T> {
    return this.request<T>("PATCH", this.projectUrl(path, opts.query), {
      contentType: ADO_PATCH_MEDIA_TYPE,
      body: JSON.stringify(patch),
    });
  }

  /** Org-scoped GET (paths starting from `_apis/...`, no project segment). */
  async getJsonOrg<T>(path: string, opts: AdoRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", this.orgUrl(path, opts.query));
  }

  /** Build a project-scoped URL with api-version always set. */
  private projectUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(
      `${encodeURIComponent(this.options.organization)}/${encodeURIComponent(this.options.project)}/_apis/${stripLeadingSlash(path)}`,
      this.baseUrl + "/",
    );
    this.applyQuery(url, query);
    url.searchParams.set("api-version", this.options.apiVersion);
    return url.toString();
  }

  private orgUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(
      `${encodeURIComponent(this.options.organization)}/_apis/${stripLeadingSlash(path)}`,
      this.baseUrl + "/",
    );
    this.applyQuery(url, query);
    url.searchParams.set("api-version", this.options.apiVersion);
    return url.toString();
  }

  private applyQuery(url: URL, query?: Record<string, string | number | boolean | undefined>): void {
    if (!query) return;
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  private async request<T>(
    method: string,
    url: string,
    init: { contentType?: string; body?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (init.contentType) headers["Content-Type"] = init.contentType;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: init.body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AdoError({ status: 0, statusText: "fetch_failed", url }, redactSecrets(message, this.options.pat));
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new AdoError(
        {
          status: res.status,
          statusText: res.statusText,
          url,
          body: tryJson(text),
        },
        `ADO ${res.status} ${res.statusText} ${redactSecrets(text, this.options.pat).slice(0, 500)}`,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function redactSecrets(value: string, pat: string): string {
  if (!pat) return value;
  let out = value.split(pat).join("[REDACTED_PAT]");
  // Also redact anything that looks like a Basic auth header value.
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]");
  return out;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}
