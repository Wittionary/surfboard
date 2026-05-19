import type {
  OperationResult,
  PullAllRequest,
  PullItemRequest,
  PushAllRequest,
  PushItemRequest,
  ValidateRequest,
  ValidationIssue,
  WorkItemSelector,
  WorkItemType,
} from "./types.ts";

export type {
  OperationResult,
  PullAllRequest,
  PullItemRequest,
  PushAllRequest,
  PushItemRequest,
  ValidateRequest,
};

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

export type ScaffoldChildRequest = {
  parent: WorkItemSelector;
};

export type ScaffoldChildResponse = {
  localId: string;
  workItemType: WorkItemType;
  yamlPath: string;
  yamlDocumentIndex: number;
};

export type AuditListRequest = {
  limit?: string;
};

export type AuditListResponse<TAuditRow = unknown> = {
  items: TAuditRow[];
};

export type WebhookResponse =
  | { status: "accepted"; id?: number }
  | { status: "ignored"; reason?: string }
  | { status: "rejected"; reason?: string };

export type PullAllResponse = OperationResult;
export type PullItemResponse = OperationResult;
export type PushAllResponse = OperationResult;
export type PushItemResponse = OperationResult;
