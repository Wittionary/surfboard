// Local HTTP API routes per spec §17. Phase 2 wires the local-only routes:
// workspace status, refresh, validate, and view-by-local-id. Pull/push/audit/
// webhook routes come in later phases.

import type { FastifyInstance } from "fastify";
import type { AdoClient } from "./adoClient.ts";
import type { Database } from "bun:sqlite";
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
  ValidationIssue,
  WorkItemType,
} from "../shared/types.ts";
import { SYSTEM_STATE_FIELD, SYSTEM_TITLE_FIELD } from "../shared/constants.ts";

export type WorkspaceStatusResponse = {
  workspaceDir: string;
  templateDir: string;
  refreshedAt: string;
  documentCount: number;
  validItemCount: number;
  issueCounts: Record<string, number>;
};

export type ValidateResponse = {
  scope: ValidateRequest["scope"];
  itemCount: number;
  issues: ValidationIssue[];
};

export type WorkItemView = {
  localId: string;
  adoId?: number;
  workItemType: WorkItemType;
  title?: string;
  state?: string;
  yamlPath: string;
  yamlDocumentIndex: number;
  parentLocalId?: string;
  parentAdoId?: number;
  validationIssues: ValidationIssue[];
};

export type ParentViewResponse = {
  parent: WorkItemView;
  children: WorkItemView[];
};

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

export function registerPullRoutes(app: FastifyInstance, deps: PullRouteDeps): void {
  app.post<{ Body: PullAllRequest }>("/api/pull/all", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || (body.parent.localId === undefined && body.parent.adoId === undefined)) {
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
    // Refresh local cache view so subsequent /api/view reflects new YAML.
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOpResult(result));
    return result;
  });

  app.post<{ Body: PullItemRequest }>("/api/pull/item", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || (body.item.localId === undefined && body.item.adoId === undefined)) {
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
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOpResult(result));
    return result;
  });

  app.post<{ Body: PushAllRequest }>("/api/push/all", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || (body.parent.localId === undefined && body.parent.adoId === undefined)) {
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
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOpResult(result));
    return result;
  });

  app.post<{ Body: PushItemRequest }>("/api/push/item", async (req, reply): Promise<OperationResult | undefined> => {
    const body = req.body;
    if (!body || (body.item.localId === undefined && body.item.adoId === undefined)) {
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
    deps.workspace.refresh();
    deps.workspace.recordLastSync(summarizeOpResult(result));
    return result;
  });
}

export type AuditRouteDeps = {
  db: Database;
};

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get<{ Querystring: { limit?: string } }>("/api/audit/recent", async (req) => {
    const { getRecentAudit } = await import("./audit.ts");
    const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 50;
    return { items: getRecentAudit(deps.db, Number.isFinite(limit) ? limit : 50) };
  });
  app.get<{ Params: { localId: string }; Querystring: { limit?: string } }>(
    "/api/audit/item/:localId",
    async (req, reply) => {
      const localId = req.params.localId;
      if (!localId) return reply.code(400).send({ error: "localId required" });
      const { getAuditByLocalId } = await import("./audit.ts");
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 50;
      return { items: getAuditByLocalId(deps.db, localId, Number.isFinite(limit) ? limit : 50) };
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
      const parentDoc = docs.find((d) => d.item?.metadata.localId === localId);
      if (!parentDoc?.item) {
        return reply.code(404).send({ error: `parent ${localId} not found` });
      }
      const parent = parentDoc.item;
      const children = docs
        .filter((d) => {
          const parentRef = d.item?.spec.parent;
          if (!parentRef) return false;
          if (parentRef.localId === parent.metadata.localId) return true;
          if (parent.metadata.adoId !== undefined && parentRef.adoId === parent.metadata.adoId) {
            return true;
          }
          return false;
        })
        .map((d) => toView(d));
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
  const parent = documents.find((d) => matchesSelector(d.item, parentSel));
  if (!parent?.item) return [];
  const children = documents.filter((d) => {
    const ref = d.item?.spec.parent;
    if (!ref) return false;
    if (parent.item && ref.localId === parent.item.metadata.localId) return true;
    if (parent.item?.metadata.adoId !== undefined && ref.adoId === parent.item.metadata.adoId) {
      return true;
    }
    return false;
  });
  return [parent, ...children];
}

function matchesSelector(
  item: LocalWorkItem | undefined,
  selector: { localId?: string; adoId?: number },
): boolean {
  if (!item) return false;
  if (selector.localId !== undefined && item.metadata.localId === selector.localId) return true;
  if (selector.adoId !== undefined && item.metadata.adoId === selector.adoId) return true;
  return false;
}

function toView(wd: WorkspaceDocument): WorkItemView {
  const item = wd.item;
  if (!item) {
    return {
      localId: "(invalid)",
      workItemType: "PBI",
      title: undefined,
      yamlPath: wd.doc.path,
      yamlDocumentIndex: wd.doc.documentIndex,
      validationIssues: wd.issues,
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
    validationIssues: wd.issues,
  };
}

function summarizeOpResult(result: OperationResult): { success: number; failure: number; blocked: number } {
  let success = 0;
  let failure = 0;
  let blocked = 0;
  for (const item of result.items) {
    if (item.status === "success") success += 1;
    else if (item.status === "failed") failure += 1;
    else if (item.status === "blocked" || item.status === "requires_confirmation") blocked += 1;
  }
  return { success, failure, blocked };
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
