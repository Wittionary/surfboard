// Advisory webhook handler per spec §12. Stores every received event in
// `webhook_events`, extracts the work item id+rev when present, and (when the
// rev exceeds the cached baseline) marks the cached item as remote_changed —
// without modifying YAML or triggering any sync.

import type { Database } from "bun:sqlite";
import {
  getCachedByAdoId,
  updateRemoteObserved,
} from "./db.ts";

export type WebhookHandlerOptions = {
  db: Database;
  /** When set, requests must include this value in the configured header. */
  secret: string | null;
  /** Header name carrying the secret. Defaults to `x-surfboard-webhook-secret`. */
  secretHeader?: string;
};

export type WebhookProcessResult = {
  status: "stored" | "rejected";
  eventId?: number;
  adoId?: number;
  rev?: number;
  cacheUpdated: boolean;
  reason?: string;
};

export function processWebhookEvent(
  options: WebhookHandlerOptions,
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
): WebhookProcessResult {
  if (options.secret) {
    const headerName = (options.secretHeader ?? "x-surfboard-webhook-secret").toLowerCase();
    const supplied = headerValue(headers, headerName);
    if (supplied !== options.secret) {
      return { status: "rejected", cacheUpdated: false, reason: "secret_mismatch" };
    }
  }

  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
  const event = parseEventBasics(payload);

  // Insert raw event for audit/debugging regardless of shape.
  const result = options.db.run(
    `INSERT INTO webhook_events (received_at, event_type, ado_id, rev, raw_payload, processed)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      event.eventType ?? "unknown",
      event.adoId ?? null,
      event.rev ?? null,
      rawText,
      0,
    ],
  );
  const eventId = Number(result.lastInsertRowid);

  if (event.adoId === undefined || event.rev === undefined) {
    options.db.run(`UPDATE webhook_events SET processed = 1 WHERE id = ?`, [eventId]);
    return { status: "stored", eventId, cacheUpdated: false, reason: "no_id_or_rev" };
  }

  const cached = getCachedByAdoId(options.db, event.adoId);
  let cacheUpdated = false;
  if (cached && cached.lastKnownRev !== undefined && event.rev > cached.lastKnownRev) {
    updateRemoteObserved(options.db, {
      localId: cached.localId,
      remoteRev: event.rev,
      syncStatus: "remote_changed",
    });
    cacheUpdated = true;
  }
  options.db.run(`UPDATE webhook_events SET processed = 1 WHERE id = ?`, [eventId]);
  return {
    status: "stored",
    eventId,
    adoId: event.adoId,
    rev: event.rev,
    cacheUpdated,
  };
}

type EventBasics = { eventType?: string; adoId?: number; rev?: number };

function parseEventBasics(payload: unknown): EventBasics {
  if (typeof payload !== "object" || payload === null) return {};
  const obj = payload as Record<string, unknown>;
  const out: EventBasics = {};
  if (typeof obj.eventType === "string") out.eventType = obj.eventType;

  // ADO event payloads typically place the work item under resource.fields or
  // resource itself.
  const resource = obj.resource as Record<string, unknown> | undefined;
  if (resource) {
    if (typeof resource.id === "number") out.adoId = resource.id;
    if (typeof resource.rev === "number") out.rev = resource.rev;
    const fields = resource.fields as Record<string, unknown> | undefined;
    if (fields) {
      if (out.adoId === undefined && typeof fields["System.Id"] === "number") {
        out.adoId = fields["System.Id"];
      }
      if (out.rev === undefined && typeof fields["System.Rev"] === "number") {
        out.rev = fields["System.Rev"];
      }
    }
  }
  return out;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function getRecentWebhookEvents(
  db: Database,
  limit: number = 50,
): Array<{ id: number; receivedAt: string; eventType: string; adoId: number | null; rev: number | null }> {
  type Row = {
    id: number;
    received_at: string;
    event_type: string;
    ado_id: number | null;
    rev: number | null;
  };
  const rows = db
    .query("SELECT id, received_at, event_type, ado_id, rev FROM webhook_events ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 500))) as Row[];
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    eventType: r.event_type,
    adoId: r.ado_id,
    rev: r.rev,
  }));
}
