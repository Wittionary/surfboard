// Local HTTP API routes per spec §17. Phase 2 wires the local-only routes:
// workspace status, refresh, validate, and view-by-local-id. Pull/push/audit/
// webhook routes come in later phases.

import type { FastifyInstance } from "fastify";
import type { AdoClient } from "./adoClient.ts";
import type { Database } from "bun:sqlite";
import { childLog } from "./logger.ts";
import {
  pullParentAndChildren,
  pullSingleItem,
  pushParentAndChildren,
  pushSingleItem,
} from "./syncEngine.ts";
import type { WorkspaceState } from "./workspaceState.ts";
import type { WorkspaceDocument } from "./workspace.ts";
import type {
  LocalWorkItem,
  OperationResult,
  PullAllRequest,
  PullItemRequest,
  PushAllRequest,
  PushItemRequest,
  ValidateRequest,
  WorkItemType,
} from "../shared/types.ts";
import type {
  ParentViewResponse,
  ScaffoldChildRequest,
  ScaffoldChildResponse,
  ValidateResponse,
  WorkItemView,
  WorkspaceStatusResponse,
} from "../shared/api.ts";
import { PARENT_MATRIX, SYSTEM_STATE_FIELD, SYSTEM_TITLE_FIELD } from "../shared/constants.ts";
import { appendDocument, findIssueLine } from "./yamlStore.ts";
import { upsertWorkItemCache } from "./db.ts";
import { findDirectChildDocuments, findDocumentBySelector, matchesSelector } from "./workItemRefs.ts";
import { summarizeOperationResult } from "./syncResult.ts";

export type RouteDeps = {
  workspace: WorkspaceState;
};

export type PullRouteDeps = {
  workspace: WorkspaceState;
  client: AdoClient;
  db: Database;
  workspaceDir: string;
  pat?: string;
};

const log = childLog("sync");

function logOpResult(op: string, result: OperationResult): void {
  const { success, failure, blocked } = summarizeOperationResult(result);
  const level = result.status === "success" ? "info" : result.status === "failed" ? "error" : "warn";
  log[level]({ op, status: result.status, success, failure, blocked }, op);
  for (const item of result.items) {
    if (item.status === "failed" || item.status === "blocked") {
      log.warn(
        { op, localId: item.localId, adoId: item.adoId, status: item.status, errorCode: item.errorCode },
        item.errorMessage ?? item.errorCode ?? item.status,
      );
    }
  }
}

export function registerPullRoutes(app: FastifyInstance, deps: PullRouteDeps): void {
  app.post<{ Body: PullAllRequest }>("/api/pull/all", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || !hasSelector(body.parent)) {
      return reply.code(400).send({ error: "parent selector required (localId or adoId)" });
    }
    const result = await pullParentAndChildren(
      {
        client: deps.client,
        db: deps.db,
        workspaceDir: deps.workspaceDir,
        pat: deps.pat,
      },
      { selector: body.parent, confirmations: body.confirmations },
    );
    const enriched = enrichWithTitles(result, deps.workspace);
    logOpResult("pull-all", enriched);
    // Refresh local cache view so subsequent /api/view reflects new YAML.
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOperationResult(enriched));
    return enriched;
  });

  app.post<{ Body: PullItemRequest }>("/api/pull/item", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || !hasSelector(body.item)) {
      return reply.code(400).send({ error: "item selector required (localId or adoId)" });
    }
    const result = await pullSingleItem(
      {
        client: deps.client,
        db: deps.db,
        workspaceDir: deps.workspaceDir,
        pat: deps.pat,
      },
      { selector: body.item, confirmation: body.confirmation },
    );
    const enriched = enrichWithTitles(result, deps.workspace);
    logOpResult("pull-item", enriched);
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOperationResult(enriched));
    return enriched;
  });

  app.post<{ Body: PushAllRequest }>("/api/push/all", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || !hasSelector(body.parent)) {
      return reply.code(400).send({ error: "parent selector required (localId or adoId)" });
    }
    const result = await pushParentAndChildren(
      {
        client: deps.client,
        db: deps.db,
        workspaceDir: deps.workspaceDir,
        pat: deps.pat,
      },
      {
        parent: body.parent,
        includeParent: body.includeParent,
        childLocalIds: body.childLocalIds,
        confirmedParentChanges: body.confirmedParentChanges,
      },
    );
    const enriched = enrichWithTitles(result, deps.workspace);
    logOpResult("push-all", enriched);
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOperationResult(enriched));
    return enriched;
  });

  app.post<{ Body: PushItemRequest }>("/api/push/item", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || !hasSelector(body.item)) {
      return reply.code(400).send({ error: "item selector required (localId or adoId)" });
    }
    const result = await pushSingleItem(
      {
        client: deps.client,
        db: deps.db,
        workspaceDir: deps.workspaceDir,
        pat: deps.pat,
      },
      {
        selector: body.item,
        confirmedParentChange: body.confirmedParentChange,
      },
    );
    const enriched = enrichWithTitles(result, deps.workspace);
    logOpResult("push-item", enriched);
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOperationResult(enriched));
    return enriched;
  });
}

export type AuditRouteDeps = {
  db: Database;
};

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get<{ Querystring: { limit?: string } }>("/api/audit/recent", async (req) => {
    const { getRecentAudit } = await import("./audit.ts");
    return { items: getRecentAudit(deps.db, parseLimit(req.query.limit)) };
  });
  app.get<{ Params: { localId: string }; Querystring: { limit?: string } }>(
    "/api/audit/item/:localId",
    async (req, reply) => {
      const localId = req.params.localId;
      if (!localId) return reply.code(400).send({ error: "localId required" });
      const { getAuditByLocalId } = await import("./audit.ts");
      return { items: getAuditByLocalId(deps.db, localId, parseLimit(req.query.limit)) };
    },
  );
}

export type WebhookRouteDeps = {
  db: Database;
  secret: string | null;
};

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  app.post("/api/webhooks/ado", async (req, reply) => {
    const { processWebhookEvent } = await import("./webhookServer.ts");
    const result = processWebhookEvent(
      { db: deps.db, secret: deps.secret },
      req.headers as Record<string, string | string[] | undefined>,
      req.body,
    );
    if (result.status === "rejected") {
      return reply.code(401).send({ error: result.reason ?? "rejected" });
    }
    return result;
  });
}

export function registerLocalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/workspace/status", async (): Promise<WorkspaceStatusResponse> => {
    const snapshot = deps.workspace.current();
    return summarizeStatus(snapshot);
  });

  app.post("/api/workspace/refresh", async (): Promise<WorkspaceStatusResponse> => {
    const snapshot = deps.workspace.refresh({ pruneOrphans: true });
    return summarizeStatus(snapshot);
  });

  app.post<{ Body: ValidateRequest }>("/api/validate", async (req, reply) => {
    const body = req.body ?? { scope: "workspace" };
    if (!body.scope || (body.scope !== "workspace" && body.scope !== "displayed" && body.scope !== "item")) {
      return reply.code(400).send({ error: "scope must be workspace | displayed | item" });
    }
    const snapshot = deps.workspace.current();
    const documents = filterDocumentsForValidate(snapshot.scan.documents, body);
    const issues = documents.flatMap((d) => d.issues);
    const out: ValidateResponse = {
      scope: body.scope,
      itemCount: documents.length,
      issues,
    };
    return out;
  });

  app.get<{ Params: { localId: string } }>(
    "/api/view/parent/:localId",
    async (req, reply): Promise<ParentViewResponse | undefined> => {
      const localId = req.params.localId;
      const snapshot = deps.workspace.current();
      const docs = snapshot.scan.documents;
      const parentDoc = findDocumentBySelector(docs, { localId });
      if (!parentDoc?.item) {
        return reply.code(404).send({ error: `parent ${localId} not found` });
      }
      const parent = parentDoc.item;
      const children = findDirectChildDocuments(docs, parent).map((d) => toView(d));
      return {
        parent: toView(parentDoc),
        children,
      };
    },
  );
}

function filterDocumentsForValidate(
  documents: readonly WorkspaceDocument[],
  body: ValidateRequest,
): WorkspaceDocument[] {
  if (body.scope === "workspace") return [...documents];
  if (body.scope === "item") {
    const sel = body.item ?? {};
    return documents.filter((d) => matchesSelector(d.item, sel));
  }
  // "displayed" — like parent view: include parent + direct children.
  const parentSel = body.parent ?? {};
  const parent = findDocumentBySelector(documents, parentSel);
  if (!parent?.item) return [];
  const children = findDirectChildDocuments(documents, parent.item);
  return [parent, ...children];
}

function toView(wd: WorkspaceDocument): WorkItemView {
  const item = wd.item;
  const withLines = wd.issues.map((issue) => ({
    ...issue,
    line: findIssueLine(
      issue.yamlPath ?? wd.doc.path,
      issue.yamlDocumentIndex ?? wd.doc.documentIndex,
      issue.field,
    ),
  }));
  if (!item) {
    return {
      localId: "(invalid)",
      workItemType: "PBI",
      title: undefined,
      yamlPath: wd.doc.path,
      yamlDocumentIndex: wd.doc.documentIndex,
      validationIssues: withLines,
    };
  }
  const title = item.spec.fields[SYSTEM_TITLE_FIELD];
  const state = item.spec.fields[SYSTEM_STATE_FIELD];
  return {
    localId: item.metadata.localId,
    adoId: item.metadata.adoId,
    workItemType: item.kind,
    title: typeof title === "string" ? title : undefined,
    state: typeof state === "string" ? state : undefined,
    yamlPath: item.yamlPath,
    yamlDocumentIndex: item.yamlDocumentIndex,
    parentLocalId: item.spec.parent?.localId,
    parentAdoId: item.spec.parent?.adoId,
    validationIssues: withLines,
  };
}

/** Stamps `title` onto each ItemOperationResult using the current workspace scan. */
function enrichWithTitles(result: OperationResult, workspace: WorkspaceState): OperationResult {
  const titleByLocalId = new Map<string, string>();
  for (const doc of workspace.current().scan.documents) {
    if (!doc.item) continue;
    const t = doc.item.spec.fields[SYSTEM_TITLE_FIELD];
    if (typeof t === "string" && t) titleByLocalId.set(doc.item.metadata.localId, t);
  }
  return {
    ...result,
    items: result.items.map((item) => {
      const t = item.localId ? titleByLocalId.get(item.localId) : undefined;
      return t ? { ...item, title: t } : item;
    }),
  };
}

// Feature → PBI is the user-selected default; all other types have exactly one valid child.
const SCAFFOLD_CHILD_TYPE: Partial<Record<WorkItemType, WorkItemType>> = {
  Epic: "Feature",
  Feature: "PBI",
  PBI: "Task",
  Enabler: "Task",
};

export type ScaffoldRouteDeps = {
  workspace: WorkspaceState;
  db: Database;
};

export function registerScaffoldRoutes(app: FastifyInstance, deps: ScaffoldRouteDeps): void {
  app.post<{ Body: ScaffoldChildRequest }>(
    "/api/scaffold/child",
    async (req, reply): Promise<ScaffoldChildResponse | undefined> => {
      const body = req.body;
      if (!body?.parent || !hasSelector(body.parent)) {
        return reply.code(400).send({ error: "parent selector required (localId or adoId)" });
      }

      const snapshot = deps.workspace.current();
      const parentDoc = findDocumentBySelector(snapshot.scan.documents, body.parent);

      if (!parentDoc?.item) {
        return reply.code(404).send({ error: "parent not found in workspace" });
      }

      const parentItem = parentDoc.item;
      const childType = SCAFFOLD_CHILD_TYPE[parentItem.kind];
      if (!childType) {
        return reply.code(400).send({ error: `${parentItem.kind} items cannot have child work items` });
      }

      const localId = `${childType.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const stub: LocalWorkItem = {
        apiVersion: "surfboard.ado/v1",
        kind: childType,
        metadata: { localId },
        spec: {
          parent: {
            localId: parentItem.metadata.localId,
            ...(parentItem.metadata.adoId !== undefined ? { adoId: parentItem.metadata.adoId } : {}),
          },
          fields: { [SYSTEM_TITLE_FIELD]: `New ${childType}` },
        },
        yamlPath: parentItem.yamlPath,
        yamlDocumentIndex: 0,
      };

      const docIndex = appendDocument(parentItem.yamlPath, stub);
      stub.yamlDocumentIndex = docIndex;

      upsertWorkItemCache(deps.db, {
        localId,
        workItemType: childType,
        yamlPath: parentItem.yamlPath,
        yamlDocumentIndex: docIndex,
        parentLocalId: parentItem.metadata.localId,
        parentAdoId: parentItem.metadata.adoId,
        syncStatus: "local_only",
      });

      deps.workspace.refresh();

      return { localId, workItemType: childType, yamlPath: parentItem.yamlPath, yamlDocumentIndex: docIndex };
    },
  );
}

function hasSelector(selector: { localId?: string; adoId?: number } | undefined): boolean {
  return selector !== undefined && (selector.localId !== undefined || selector.adoId !== undefined);
}

function parseLimit(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 50;
  return Number.isFinite(parsed) ? parsed : 50;
}

function summarizeStatus(snapshot: ReturnType<WorkspaceState["current"]>): WorkspaceStatusResponse {
  const counts: Record<string, number> = {};
  for (const issue of snapshot.scan.issues) {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  return {
    workspaceDir: snapshot.scan.workspaceDir,
    templateDir: snapshot.templateDir,
    refreshedAt: snapshot.refreshedAt,
    documentCount: snapshot.scan.documents.length,
    validItemCount: snapshot.scan.documents.filter((d) => d.item).length,
    issueCounts: counts,
  };
}
