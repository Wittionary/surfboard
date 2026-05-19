import type {
  ParentViewResponse,
  ScaffoldChildRequest,
  ScaffoldChildResponse,
  WorkspaceStatusResponse,
} from "../shared/api.ts";
import type { HealthReport } from "../shared/types.ts";

export async function loadJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function getWorkspaceStatus(): Promise<WorkspaceStatusResponse | null> {
  return loadJson<WorkspaceStatusResponse>("/api/workspace/status");
}

export function refreshWorkspace(): Promise<WorkspaceStatusResponse | null> {
  return postJson<WorkspaceStatusResponse>("/api/workspace/refresh", {});
}

export function getHealth(): Promise<HealthReport | null> {
  return loadJson<HealthReport>("/api/health");
}

export function getParentView(localId: string): Promise<ParentViewResponse | null> {
  return loadJson<ParentViewResponse>(`/api/view/parent/${encodeURIComponent(localId)}`);
}

export function scaffoldChild(request: ScaffoldChildRequest): Promise<ScaffoldChildResponse | null> {
  return postJson<ScaffoldChildResponse>("/api/scaffold/child", request);
}
