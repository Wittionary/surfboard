// Domain, request, result, and validation types per spec §17 and §18.

export type WorkItemType = "Epic" | "Feature" | "PBI" | "Enabler" | "Task";

export type SyncStatus =
  | "local_only"
  | "synced"
  | "local_changed"
  | "remote_changed"
  | "conflict_blocked"
  | "validation_failed"
  | "push_failed"
  | "pull_failed"
  | "deleted_remotely";

export type LocalWorkItem = {
  apiVersion: "surfboard.ado/v1";
  kind: WorkItemType;
  metadata: {
    localId: string;
    adoId?: number;
  };
  spec: {
    parent?: {
      localId?: string;
      adoId?: number;
    };
    tags?: string[];
    fields: Record<string, unknown>;
  };
  yamlPath: string;
  yamlDocumentIndex: number;
};

export type CachedWorkItem = {
  localId: string;
  adoId?: number;
  workItemType: WorkItemType;
  yamlPath: string;
  yamlDocumentIndex: number;
  parentLocalId?: string;
  parentAdoId?: number;
  lastKnownRev?: number;
  lastKnownFieldHash?: string;
  lastKnownRelationHash?: string;
  lastRemoteRev?: number;
  localFileHash?: string;
  syncStatus: SyncStatus;
  lastPulledAt?: string;
  lastPushedAt?: string;
  remoteChangedAt?: string;
  remoteCheckedAt?: string;
};

export type ValidationIssueCode =
  | "yaml_invalid"
  | "unknown_top_level_key"
  | "unknown_field"
  | "missing_required_field"
  | "invalid_field_type"
  | "invalid_enum_value"
  | "invalid_kind"
  | "invalid_api_version"
  | "tags_not_allowed"
  | "missing_parent"
  | "invalid_parent_type"
  | "missing_parent_ado_id"
  | "duplicate_local_id"
  | "duplicate_sibling_title"
  | "missing_cached_revision"
  | "remote_revision_changed"
  | "remote_deleted"
  | "yaml_changed_during_push"
  | "template_missing"
  | "template_duplicate"
  | "template_malformed";

export type ValidationIssue = {
  severity: "error" | "warning";
  code: ValidationIssueCode;
  message: string;
  yamlPath?: string;
  yamlDocumentIndex?: number;
  localId?: string;
  field?: string;
  line?: number;
};

export type WorkItemSelector = {
  localId?: string;
  adoId?: number;
};

export type PullOverwriteConfirmation = {
  localId?: string;
  adoId: number;
  yamlPath: string;
  yamlDocumentIndex: number;
  remoteRev: number;
  confirmed: true;
};

export type ValidateRequest = {
  scope: "workspace" | "displayed" | "item";
  parent?: WorkItemSelector;
  item?: WorkItemSelector;
};

export type PullAllRequest = {
  parent: WorkItemSelector;
  confirmations?: PullOverwriteConfirmation[];
};

export type PullItemRequest = {
  item: WorkItemSelector;
  confirmation?: PullOverwriteConfirmation;
};

export type PushAllRequest = {
  parent: WorkItemSelector;
  includeParent?: boolean;
  childLocalIds?: string[];
  confirmedParentChanges?: string[];
};

export type PushItemRequest = {
  item: WorkItemSelector;
  confirmedParentChange?: boolean;
};

export type ChangedValue = {
  path: string;
  before?: unknown;
  after?: unknown;
};

export type ItemOperationAction =
  | "validate"
  | "pull"
  | "create"
  | "update"
  | "skip"
  | "block";

export type ItemOperationStatus =
  | "success"
  | "blocked"
  | "failed"
  | "skipped"
  | "requires_confirmation";

export type ConfirmationRequired = "overwrite_yaml" | "change_parent";

export type ItemOperationResult = {
  localId?: string;
  adoId?: number;
  title?: string;
  workItemType?: WorkItemType;
  yamlPath?: string;
  yamlDocumentIndex?: number;
  action: ItemOperationAction;
  status: ItemOperationStatus;
  syncStatus?: SyncStatus;
  beforeRev?: number;
  afterRev?: number;
  cachedRev?: number;
  remoteRev?: number;
  changedValues?: ChangedValue[];
  validationIssues?: ValidationIssue[];
  confirmationRequired?: ConfirmationRequired;
  errorCode?: string;
  errorMessage?: string;
};

export type OperationStatus = "success" | "partial_failure" | "blocked" | "failed";

export type OperationSummary = {
  validated: number;
  created: number;
  updated: number;
  pulled: number;
  blocked: number;
  failed: number;
};

export type OperationResult = {
  operationId: string;
  status: OperationStatus;
  summary: OperationSummary;
  items: ItemOperationResult[];
};

export type HealthStatus = "ok" | "degraded" | "failed" | "disabled";

export type HealthReport = {
  app: {
    version: string;
    status: HealthStatus;
  };
  config: {
    status: HealthStatus;
    workspaceDir?: string;
    templateDir?: string;
    organization?: string;
    project?: string;
    apiVersion?: string;
    issues: string[];
  };
  sqlite: {
    status: HealthStatus;
    path?: string;
    error?: string;
  };
  workspace: {
    status: HealthStatus;
    path?: string;
    error?: string;
  };
  templates: {
    status: HealthStatus;
    path?: string;
    error?: string;
  };
  ado?: {
    auth: HealthStatus;
    project: HealthStatus;
    lastError?: string;
  };
  webhook?: {
    status: HealthStatus;
    lastEventAt?: string;
  };
  watcher?: {
    status: HealthStatus;
    error?: string;
  };
  lastSync?: {
    at?: string;
    success: number;
    failure: number;
    blocked: number;
  };
  validation?: {
    lastIssueCount: number;
  };
};
