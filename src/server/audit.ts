// Audit log writer per spec §16. Every pull/push attempt writes a row.
//
// Hard rule: PATs, Authorization headers, and any other credentials must
// never appear in request_summary or response_summary. The redact() helper
// is the chokepoint; callers can also opt to pre-redact strings before
// calling writeAuditEntry.

import type { Database } from "bun:sqlite";

export type AuditAction =
  | "pull"
  | "create"
  | "update"
  | "skip"
  | "block"
  | "validate"
  | "fail";

export type AuditEntry = {
  operationId: string;
  action: AuditAction;
  localId?: string;
  adoId?: number;
  workItemType?: string;
  yamlPath?: string;
  beforeRev?: number;
  afterRev?: number;
  beforeHash?: string;
  afterHash?: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  requestSummary?: unknown;
  responseSummary?: unknown;
};

export type AuditWriteOptions = {
  /** When provided, the helper redacts the literal PAT from message, request, and response strings. */
  pat?: string;
};

export function writeAuditEntry(
  db: Database,
  entry: AuditEntry,
  options: AuditWriteOptions = {},
): void {
  const reqText = jsonRedact(entry.requestSummary, options.pat);
  const resText = jsonRedact(entry.responseSummary, options.pat);
  const errText = entry.errorMessage ? redact(entry.errorMessage, options.pat) : null;
  db.run(
    `INSERT INTO audit_log (
      operation_id, timestamp, action, local_id, ado_id, work_item_type,
      yaml_path, before_rev, after_rev, before_hash, after_hash,
      success, error_code, error_message, request_summary, response_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.operationId,
      new Date().toISOString(),
      entry.action,
      entry.localId ?? null,
      entry.adoId ?? null,
      entry.workItemType ?? null,
      entry.yamlPath ?? null,
      entry.beforeRev ?? null,
      entry.afterRev ?? null,
      entry.beforeHash ?? null,
      entry.afterHash ?? null,
      entry.success ? 1 : 0,
      entry.errorCode ?? null,
      errText,
      reqText,
      resText,
    ],
  );
}

export type AuditRow = {
  id: number;
  operationId: string;
  timestamp: string;
  action: string;
  localId: string | null;
  adoId: number | null;
  workItemType: string | null;
  yamlPath: string | null;
  beforeRev: number | null;
  afterRev: number | null;
  beforeHash: string | null;
  afterHash: string | null;
  success: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  requestSummary: unknown;
  responseSummary: unknown;
};

type StoredRow = {
  id: number;
  operation_id: string;
  timestamp: string;
  action: string;
  local_id: string | null;
  ado_id: number | null;
  work_item_type: string | null;
  yaml_path: string | null;
  before_rev: number | null;
  after_rev: number | null;
  before_hash: string | null;
  after_hash: string | null;
  success: number;
  error_code: string | null;
  error_message: string | null;
  request_summary: string | null;
  response_summary: string | null;
};

function rowToAudit(row: StoredRow): AuditRow {
  return {
    id: row.id,
    operationId: row.operation_id,
    timestamp: row.timestamp,
    action: row.action,
    localId: row.local_id,
    adoId: row.ado_id,
    workItemType: row.work_item_type,
    yamlPath: row.yaml_path,
    beforeRev: row.before_rev,
    afterRev: row.after_rev,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    success: row.success === 1,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestSummary: row.request_summary ? safeParse(row.request_summary) : null,
    responseSummary: row.response_summary ? safeParse(row.response_summary) : null,
  };
}

export function getRecentAudit(db: Database, limit: number = 50): AuditRow[] {
  const rows = db
    .query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 500))) as StoredRow[];
  return rows.map(rowToAudit);
}

export function getAuditByLocalId(db: Database, localId: string, limit: number = 50): AuditRow[] {
  const rows = db
    .query("SELECT * FROM audit_log WHERE local_id = ? ORDER BY id DESC LIMIT ?")
    .all(localId, Math.max(1, Math.min(limit, 500))) as StoredRow[];
  return rows.map(rowToAudit);
}

function jsonRedact(value: unknown, pat?: string): string | null {
  if (value === undefined || value === null) return null;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return redact(json, pat);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const AUTH_HEADER_PATTERN = /(?:authorization|x-ms-authentication)\s*[:=]\s*(?:Basic|Bearer)?\s*[A-Za-z0-9+/=_\-.]+/gi;

export function redact(value: string, pat?: string): string {
  let out = value;
  if (pat && pat.length > 0) {
    out = out.split(pat).join("[REDACTED_PAT]");
  }
  out = out.replace(AUTH_HEADER_PATTERN, "[REDACTED_AUTH]");
  return out;
}
