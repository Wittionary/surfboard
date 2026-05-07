// ADO project metadata discovery per spec §6.1 and §11.2. Fetches the project
// (with capabilities), the project's work item types, the states for each
// supported MVP type, and the field catalog. Results are cached as JSON in
// SQLite `settings` so subsequent runs do not re-fetch on boot.

import type { Database } from "bun:sqlite";
import type { AdoClient } from "./adoClient.ts";
import { WORK_ITEM_TYPES } from "../shared/constants.ts";
import type { WorkItemType } from "../shared/types.ts";

export type AdoProjectInfo = {
  id: string;
  name: string;
  description?: string;
  processTemplate?: { templateName?: string; templateTypeId?: string };
};

export type AdoWorkItemTypeInfo = {
  name: string;
  referenceName: string;
  description?: string;
  isDisabled?: boolean;
};

export type AdoStateInfo = {
  name: string;
  category?: string;
};

export type AdoFieldInfo = {
  referenceName: string;
  name: string;
  type?: string;
  readOnly?: boolean;
  required?: boolean;
  allowedValues?: ReadonlyArray<string | number>;
};

export type AdoMetadataSnapshot = {
  fetchedAt: string;
  project: AdoProjectInfo;
  workItemTypes: AdoWorkItemTypeInfo[];
  statesByType: Partial<Record<string, AdoStateInfo[]>>;
  fields: AdoFieldInfo[];
};

const SETTINGS_KEY = "ado_metadata_snapshot";

export async function discoverAdoMetadata(client: AdoClient): Promise<AdoMetadataSnapshot> {
  const project = await fetchProject(client);
  const workItemTypes = await fetchWorkItemTypes(client);
  const fields = await fetchFields(client);
  const statesByType: Partial<Record<string, AdoStateInfo[]>> = {};
  // Fetch states only for the kinds we care about and that exist in the project.
  for (const kind of WORK_ITEM_TYPES) {
    const adoType = matchAdoType(workItemTypes, kind);
    if (!adoType) continue;
    try {
      const states = await fetchStates(client, adoType.referenceName);
      statesByType[adoType.referenceName] = states;
    } catch {
      // States are advisory; metadata discovery should not fail the whole snapshot.
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    project,
    workItemTypes,
    statesByType,
    fields,
  };
}

export function saveMetadataSnapshot(db: Database, snapshot: AdoMetadataSnapshot): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_KEY, JSON.stringify(snapshot)],
  );
}

export function loadMetadataSnapshot(db: Database): AdoMetadataSnapshot | null {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY) as { value?: string } | null;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as AdoMetadataSnapshot;
  } catch {
    return null;
  }
}

/**
 * Best-effort match of a Surfboard kind to an ADO work item type. ADO names
 * use spaces ("Product Backlog Item"); local kinds use the abbreviated form
 * ("PBI"). When the project uses the named form we match by `name`; when it
 * uses our short form we match by either `name` or `referenceName`.
 */
export function matchAdoType(
  types: readonly AdoWorkItemTypeInfo[],
  kind: WorkItemType,
): AdoWorkItemTypeInfo | undefined {
  const aliases: Record<WorkItemType, string[]> = {
    Epic: ["Epic"],
    Feature: ["Feature"],
    PBI: ["PBI", "Product Backlog Item"],
    Enabler: ["Enabler"],
    Task: ["Task"],
  };
  const wanted = aliases[kind].map((s) => s.toLowerCase());
  return types.find(
    (t) =>
      wanted.includes(t.name.toLowerCase()) ||
      wanted.includes(t.referenceName.toLowerCase()),
  );
}

async function fetchProject(client: AdoClient): Promise<AdoProjectInfo> {
  type ProjectResponse = AdoProjectInfo & { capabilities?: { processTemplate?: AdoProjectInfo["processTemplate"] } };
  const data = await client.getJsonOrg<ProjectResponse>(
    `projects/${encodeURIComponent(client.project)}`,
    { query: { includeCapabilities: true } },
  );
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    processTemplate: data.capabilities?.processTemplate ?? data.processTemplate,
  };
}

async function fetchWorkItemTypes(client: AdoClient): Promise<AdoWorkItemTypeInfo[]> {
  type Response = { value: AdoWorkItemTypeInfo[] };
  const data = await client.getJson<Response>("wit/workitemtypes");
  return data.value.map((t) => ({
    name: t.name,
    referenceName: t.referenceName,
    description: t.description,
    isDisabled: t.isDisabled ?? false,
  }));
}

async function fetchFields(client: AdoClient): Promise<AdoFieldInfo[]> {
  type Response = { value: AdoFieldInfo[] };
  const data = await client.getJson<Response>("wit/fields");
  return data.value.map((f) => ({
    referenceName: f.referenceName,
    name: f.name,
    type: f.type,
    readOnly: f.readOnly,
    required: f.required,
    allowedValues: f.allowedValues,
  }));
}

async function fetchStates(client: AdoClient, workItemTypeRef: string): Promise<AdoStateInfo[]> {
  type Response = { value: AdoStateInfo[] };
  const data = await client.getJson<Response>(
    `wit/workitemtypes/${encodeURIComponent(workItemTypeRef)}/states`,
  );
  return data.value.map((s) => ({ name: s.name, category: s.category }));
}

