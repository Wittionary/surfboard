import type { Database } from "bun:sqlite";
import {
  getUpdates,
  getWorkItem,
  getWorkItems,
  isDeletedWorkItem,
  type AdoClient,
  type AdoWorkItem,
} from "./adoClient.ts";
import {
  getAllCached,
  updateRemoteObserved,
} from "./db.ts";
import { HIERARCHY_REVERSE_REL } from "../shared/constants.ts";
import type { SyncStatus } from "../shared/types.ts";

export type RemoteStatusDeps = {
  client: AdoClient;
  db: Database;
  workspaceDir?: string;
};

/**
 * Returns the current rev that ADO reports for the given remote item.
 * Convenience wrapper used by routes that want to refresh status without
 * pulling.
 */
export async function probeRemoteRev(
  deps: Pick<RemoteStatusDeps, "client">,
  adoId: number,
): Promise<{ rev: number; deleted: boolean }> {
  const item = await getWorkItem(deps.client, adoId);
  return { rev: item.rev, deleted: isDeletedWorkItem(item) };
}

export type RemoteDiagnostic = {
  localId: string;
  adoId: number;
  cachedRev: number | undefined;
  remoteRev: number | undefined;
  syncStatus: SyncStatus;
  changedFields?: string[];
  deleted?: boolean;
  error?: string;
};

/**
 * Probes ADO for every cached item (or a filtered subset) and records the
 * observed remote revision per spec §13. Does not modify YAML or the accepted
 * baseline. Returns a diagnostics array the UI can render to show drift.
 */
export async function refreshRemoteStatus(
  deps: RemoteStatusDeps,
  options: { localIds?: readonly string[] } = {},
): Promise<RemoteDiagnostic[]> {
  const cached = getAllCached(deps.db).filter((c) => c.adoId !== undefined);
  const filtered = options.localIds && options.localIds.length > 0
    ? cached.filter((c) => options.localIds!.includes(c.localId))
    : cached;
  if (filtered.length === 0) return [];

  const ids = filtered.map((c) => c.adoId as number);
  let remotes: AdoWorkItem[];
  try {
    remotes = await getWorkItems(deps.client, ids);
  } catch (err) {
    return filtered.map((c) => ({
      localId: c.localId,
      adoId: c.adoId as number,
      cachedRev: c.lastKnownRev,
      remoteRev: undefined,
      syncStatus: c.syncStatus,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  const remoteById = new Map<number, AdoWorkItem>();
  for (const r of remotes) remoteById.set(r.id, r);

  const out: RemoteDiagnostic[] = [];
  for (const c of filtered) {
    const remote = remoteById.get(c.adoId as number);
    if (!remote || isDeletedWorkItem(remote)) {
      updateRemoteObserved(deps.db, {
        localId: c.localId,
        remoteRev: c.lastKnownRev ?? 0,
        syncStatus: "deleted_remotely",
      });
      out.push({
        localId: c.localId,
        adoId: c.adoId as number,
        cachedRev: c.lastKnownRev,
        remoteRev: undefined,
        syncStatus: "deleted_remotely",
        deleted: true,
      });
      continue;
    }
    if (c.lastKnownRev === undefined) {
      out.push({
        localId: c.localId,
        adoId: c.adoId as number,
        cachedRev: undefined,
        remoteRev: remote.rev,
        syncStatus: c.syncStatus,
      });
      continue;
    }
    if (remote.rev !== c.lastKnownRev) {
      const changedFields = await summarizeChangedFields(
        deps,
        c.adoId as number,
        c.lastKnownRev,
      );
      updateRemoteObserved(deps.db, {
        localId: c.localId,
        remoteRev: remote.rev,
        syncStatus: "remote_changed",
      });
      out.push({
        localId: c.localId,
        adoId: c.adoId as number,
        cachedRev: c.lastKnownRev,
        remoteRev: remote.rev,
        syncStatus: "remote_changed",
        changedFields,
      });
      continue;
    }
    // No change — leave row alone but report.
    out.push({
      localId: c.localId,
      adoId: c.adoId as number,
      cachedRev: c.lastKnownRev,
      remoteRev: remote.rev,
      syncStatus: "synced",
    });
  }
  return out;
}

const DIAG_FIELDS = new Set([
  "System.Title",
  "System.State",
  "System.Parent",
  "System.Description",
  "System.Tags",
]);

async function summarizeChangedFields(
  deps: Pick<RemoteStatusDeps, "client">,
  adoId: number,
  sinceRev: number,
): Promise<string[]> {
  try {
    const updates = await getUpdates(deps.client, adoId);
    const since = updates.filter((u) => u.rev > sinceRev);
    const changed = new Set<string>();
    for (const u of since) {
      const fields = u.fields ?? {};
      for (const name of Object.keys(fields)) {
        if (DIAG_FIELDS.has(name)) changed.add(name);
      }
      if (u.relations) {
        const touched = (u.relations.added ?? []).concat(
          u.relations.removed ?? [],
          u.relations.updated ?? [],
        );
        if (touched.some((r) => r.rel === HIERARCHY_REVERSE_REL)) {
          changed.add("System.Parent");
        }
      }
    }
    return [...changed];
  } catch {
    return [];
  }
}
