# Specification: Local YAML-Based Azure DevOps Boards Client

## 1. Objective

Build a locally hosted TypeScript web application that lets the user manage Azure DevOps Boards work items faster than the native ADO UI by using local YAML files as the primary authoring surface.

The app should support creating, pulling, validating, staging, and syncing:

* Epics
* Features
* PBIs
* Enablers
* Tasks

The app is **not** a full Azure DevOps Boards replacement. It is a local YAML-driven staging and sync client for one Azure DevOps project.

Azure DevOps work item create/update operations should use the Work Item Tracking REST API, which supports creating and updating work items through JSON Patch documents.

---

## 2. Core Design Principles

### 2.1 Local source of truth

YAML files are authoritative for local intended state.

SQLite is **not** authoritative for work item content. SQLite is used only for:

* ADO ID mapping
* last known ADO revision
* sync status
* remote-change detection
* audit log
* file hash/cache metadata
* last sync result

### 2.2 ADO source of truth for sync safety

ADO revision metadata is authoritative for remote state.

Before pushing, the app must compare the local cached ADO revision against the latest remote revision. If the remote revision changed after the last pull/successful sync, the push must be blocked.

ADO work items retain revision/update history, and the Updates API returns deltas between revisions, which can support conflict detection and diagnostics.

### 2.3 Safety over automation

The app optimizes speed, but must prefer blocking unsafe writes over guessing.

Hard blockers:

* Missing required fields
* Invalid schema
* Missing parent relationship
* Orphaned child item
* Duplicate local aliases
* Duplicate local titles under same parent and same child work item type
* Remote changed since last pull
* Remote item deleted
* Invalid parent type
* Unknown YAML fields

### 2.4 No automatic syncing

No background push. No automatic write retry.

All write syncs must be user-triggered.

---

## 3. MVP Scope

### In scope

* One Azure DevOps organization/project
* Local web app
* TypeScript backend and lightweight frontend
* Local YAML workspace directory with subdirectories
* Multi-document YAML file support
* Local template directory for schemas
* File watcher
* SQLite metadata/cache
* REST API integration
* Webhook listener for remote-change notification
* Pull parent/children
* Create YAML file on pull if missing
* Validate YAML against templates
* Display one parent item and direct children
* Push selected parent item as an update only
* Push individual child item as create or update
* Push all valid children under selected existing parent
* Pull individual selected row
* Pull all displayed items
* Block sync on conflict
* Local audit trail
* Health/status panel

### Explicitly out of scope

* Full ADO query builder
* Full backlog replacement
* Multi-project support
* Automatic rollback
* Background write retries
* Automatic syncing
* In-app YAML editing
* Complex workflow/state transition automation
* Multi-user collaboration
* Deleting YAML files
* Creating parent items in MVP
* Opening YAML files in an external editor
* Browser-only localStorage implementation

---

## 4. User Workflow

### 4.1 Authoring workflow

1. User edits YAML files locally in another editor.
2. App watches configured workspace directory.
3. App validates changed YAML against local templates.
4. App displays selected parent item in a hero/header.
5. App displays direct children in a grid.
6. User manually pulls or pushes individual rows or all displayed rows.

### 4.2 Pull workflow

Pull is used to hydrate or refresh local YAML from ADO.

Required behavior:

1. User selects parent or enters ADO work item ID.
2. App fetches parent and direct children from ADO.
3. App safely creates YAML files for returned work items that do not exist locally.
4. If a returned work item already exists locally and the remote item changed after the last pull/successful sync, the app must require explicit popup confirmation before overwriting the existing YAML file.
5. If overwrite confirmation is not given, the app must leave the YAML file unchanged, keep the last accepted cached revision/hash unchanged, store the observed remote revision separately, and mark the item as `remote_changed`.
6. When YAML is created or overwritten, app updates SQLite accepted-baseline metadata with:

   * ADO ID
   * work item type
   * ADO revision
   * field hash
   * relation hash
   * pull timestamp

7. When overwrite is declined, app updates only remote-observed metadata:

   * last observed remote revision
   * remote changed timestamp
   * remote checked timestamp
   * sync status

### 4.3 Push workflow

Push is used to update the selected existing parent item and to create or update displayed child work items from YAML.

For MVP, parent item creation is out of scope. The selected parent must already exist in ADO before children can be pushed under it.

Required behavior:

1. Parse YAML files.
2. Validate schemas.
3. Validate hierarchy.
4. Validate required fields.
5. Resolve local aliases to ADO IDs.
6. Fetch latest remote revision for every existing item.
7. Block any item whose remote revision differs from cached revision.
8. Prevalidate the full push set.
9. Push sequentially in dependency order.
10. Stop on first failure.
11. Record audit entry for every attempted operation.

---

## 5. Local File Model

### 5.1 Workspace layout

Example:

```text
ado-workspace/
  templates/
    epic.schema.yaml
    feature.schema.yaml
    pbi.schema.yaml
    enabler.schema.yaml
    task.schema.yaml

  workitems/
    epics/
      epic-platform-reliability.yaml
    features/
      feature-observability-refresh.yaml
    pbis/
      pbi-dashboard-latency-alerts.yaml
```

The exact folder structure should be configurable, but the MVP can assume one root workspace directory with recursive discovery.

### 5.2 Multi-document YAML

Multi-document YAML is in scope for MVP. A single file may contain multiple work item documents separated by YAML document markers (`---`), and each document can be pushed, pulled, validated, and audited independently.

Identity and cache behavior:

* `metadata.localId` must be unique across the entire workspace, not just within a file.
* The physical location of a document is `yaml_path` plus `yaml_document_index`.
* Updating one document in a multi-document file must not modify sibling work item documents except for unavoidable YAML serialization formatting in the same file.
* Validation output should include file path and document index.

### 5.3 YAML item identity and shape

Each YAML work item document must use a Kubernetes-like envelope. The canonical top-level keys are:

* `apiVersion`
* `kind`
* `metadata`
* `spec`

Unknown top-level keys must fail validation.

Each YAML work item must include a stable local alias at `metadata.localId`. For new items, `metadata.adoId` may be absent.

Example:

```yaml
apiVersion: surfboard.ado/v1
kind: PBI
metadata:
  localId: pbi-dashboard-latency-alerts
  adoId: 123456
spec:
  parent:
    localId: feature-observability-refresh
    adoId: 123450
  tags:
    - reliability
    - observability
  fields:
    System.Title: Add latency alert dashboard
    System.Description: >
      Create a dashboard panel showing API latency thresholds.
    Microsoft.VSTS.Common.Priority: 2
    Microsoft.VSTS.Scheduling.Effort: 3
```

`kind` is the Azure DevOps work item type. `spec.fields` maps directly to Azure DevOps field reference names used by the Work Item Tracking REST API. `spec.tags` is the local YAML representation of ADO `System.Tags` and is serialized to ADO's semicolon-delimited tag field during sync. `spec.parent` represents the parent relation required to create or update child work items.

### 5.4 Parent relationship rules

Required parent mapping:

```text
Epic     -> none
Feature  -> Epic
PBI      -> Feature
Enabler  -> Feature
Task     -> PBI or Enabler
```

Epics are roots and do not require parents.

Features, PBIs, Enablers, and Tasks require parents. Enablers can have child Tasks.

A child item cannot be created or pushed without a valid parent. For MVP, the selected parent item must already have an ADO ID. If a child item's required parent has no ADO ID, the child push must be blocked.

---

## 6. YAML Template Schema

Templates are stored locally and versioned with the workspace.

Each template validates the Kubernetes-like work item envelope for one work item type.

Each template defines:

* Work item type / `kind`
* Required fields
* Optional fields
* Allowed enum values
* Field type
* Default values
* Parent type requirements
* ADO field reference names
* Whether `spec.tags` is allowed
* Whether unknown fields are allowed, default false

Example:

```yaml
apiVersion: surfboard.ado/v1
kind: WorkItemTemplate
metadata:
  name: pbi
spec:
  workItemType: PBI
  parentTypes:
    - Feature
  requiredFields:
    - System.Title
  optionalFields:
    - System.Description
    - Microsoft.VSTS.Common.Priority
    - Microsoft.VSTS.Scheduling.Effort
    - System.AssignedTo
    - System.IterationPath
    - System.AreaPath
    - Microsoft.VSTS.Common.AcceptanceCriteria
  tags:
    allowed: true
  fieldRules:
    Microsoft.VSTS.Common.Priority:
      type: integer
      allowedValues: [1, 2, 3, 4]
    System.State:
      type: string
      allowedValues: ["New", "Approved", "Committed", "Done"]
  unknownFields: fail
```

### 6.1 ADO field requirements and defaults

Default Azure DevOps processes only guarantee `System.Title` as required for all work item types. Other required fields can be introduced by process customization, work item type customization, or project-specific rules. ([Microsoft Learn][9])

MVP behavior:

* Treat `System.Title` as the baseline required ADO field for Epic, Feature, PBI, Enabler, and Task.
* Enforce this app's parent requirements separately from ADO field requirements.
* Apply no app-level defaults yet for `System.AreaPath`, `System.IterationPath`, `System.State`, `System.AssignedTo`, or other fields. If absent from YAML, omit them from the JSON Patch and let ADO/project rules decide whether the operation is valid.
* Require `System.AssignedTo` values in YAML to be email addresses.
* Treat Enabler as a custom work item type unless the target ADO project exposes it as a first-class type.

The app should discover project metadata at startup or workspace refresh and use it to validate local templates. ([Microsoft Learn][6], [Microsoft Learn][7], [Microsoft Learn][10])

* Get the project with capabilities to identify the process template when available.
* List work item types for the configured project.
* Get work item type definitions and states for Epic, Feature, PBI, Enabler, and Task.
* List fields for the project/work item type where the API exposes them.
* Merge discovered field names, types, allowed values, and required markers into local template validation.

Local templates may be stricter than ADO metadata, but they must not allow fields that ADO does not expose for the configured project.

Recommended initial template field sets:

```text
Epic:
  required: System.Title
  optional: System.Description, System.AssignedTo, System.AreaPath, System.IterationPath, System.State, Microsoft.VSTS.Common.Priority, Microsoft.VSTS.Common.BusinessValue

Feature:
  required: System.Title
  optional: System.Description, System.AssignedTo, System.AreaPath, System.IterationPath, System.State, Microsoft.VSTS.Common.Priority, Microsoft.VSTS.Common.BusinessValue

PBI:
  required: System.Title
  optional: System.Description, System.AssignedTo, System.AreaPath, System.IterationPath, System.State, Microsoft.VSTS.Common.Priority, Microsoft.VSTS.Scheduling.Effort, Microsoft.VSTS.Common.BusinessValue, Microsoft.VSTS.Common.AcceptanceCriteria

Enabler:
  required: System.Title
  optional: System.Description, System.AssignedTo, System.AreaPath, System.IterationPath, System.State, Microsoft.VSTS.Common.Priority, Microsoft.VSTS.Scheduling.Effort, Microsoft.VSTS.Common.BusinessValue, Microsoft.VSTS.Common.AcceptanceCriteria

Task:
  required: System.Title
  optional: System.Description, System.AssignedTo, System.AreaPath, System.IterationPath, System.State, Microsoft.VSTS.Scheduling.RemainingWork, Microsoft.VSTS.Common.Activity, Microsoft.VSTS.Scheduling.OriginalEstimate, Microsoft.VSTS.Scheduling.CompletedWork
```

---

## 7. Validation Rules

Validation must be hard-blocking.

Fail validation when:

* YAML is invalid
* Required field missing
* Unknown top-level key or unknown field present
* Invalid enum value
* Invalid parent type
* Required parent missing for a Feature, PBI, Enabler, or Task
* Parent ADO ID missing for a child push in MVP
* Duplicate `metadata.localId`
* Duplicate title among local YAML siblings with the same parent and same child work item type
* Existing item lacks cached ADO revision
* Remote revision changed
* Remote item deleted
* YAML changed while push is in progress

Validation output should be grouped by file and YAML document index.

Hashing is an implementation detail, but the implementation should follow normal sync-client practice: compute field and relation hashes from canonical normalized data so YAML formatting and comments do not create false content changes; keep enough file/document metadata to detect edits while a push is in progress.

Duplicate title checks should normalize titles by trimming leading/trailing whitespace, collapsing internal whitespace, and comparing case-insensitively.

---

## 8. UI Specification

### 8.1 Layout

The frontend should be minimal.

Primary view:

```text
+------------------------------------------------------+
| Parent Hero/Header                                   |
| Type | Title | ADO ID | State | Rev | Sync Status     |
+------------------------------------------------------+

+------------------------------------------------------+
| Direct Children Grid                                 |
| Status | Type | Title | ADO ID | State | Rev | Actions |
+------------------------------------------------------+

+------------------------------------------------------+
| Footer / Health / Last Sync Summary                  |
+------------------------------------------------------+
```

### 8.2 Parent hero/header

Show:

* Work item type
* Title
* ADO ID
* Local file path
* Last known revision
* Current sync status
* Last pulled timestamp
* Last pushed timestamp
* Conflict indicator

### 8.3 Child grid

Rows represent direct children only.

Show:

* Status icon
* Work item type
* Title
* Local ID
* ADO ID
* State
* Parent
* Cached ADO revision
* Last remote revision if known
* Validation state
* Last operation result

### 8.4 Status icons

Suggested statuses:

```text
Valid local only
Synced
Local changes pending
Remote changed
Conflict blocked
Validation failed
Push failed
Pull failed
Deleted remotely
```

The “remote changed” state must block push until pull is performed.

### 8.5 Actions

Global actions:

* Pull all displayed
* Push all displayed
* Validate all
* Refresh file cache
* Open health panel

Row actions:

* Pull selected row
* Push selected row
* Validate selected row
* View last audit entry

### 8.6 Pull overwrite confirmation

When a pull would overwrite an existing local YAML file because the remote item changed after the last pull/successful sync, the frontend must show a popup confirmation before the backend writes the replacement YAML.

The popup should identify:

* Work item type
* Title
* Local ID
* ADO ID
* Local YAML path
* Cached revision
* Remote revision

The default action must be cancel/no overwrite.

### 8.7 Hotkeys

Required:

```text
Alt+Shift+U: push all displayed
Alt+Shift+I: pull all displayed
Alt+Shift+J: push selected row
Alt+Shift+K: pull selected row
Alt+Shift+V: refresh/validate workspace
```

Shortcuts must avoid common browser defaults. If a browser or operating system intercepts one of these combinations, the UI action remains the source of truth and the shortcut can be disabled or remapped later.

---

## 9. Backend Architecture

### 9.1 Runtime

Use TypeScript.

Recommended implementation:

```text
Node.js
Fastify or native HTTP server
SQLite
Minimal frontend with Vite or static TypeScript
```

Keep dependencies minimal.

Suggested dependency categories:

* HTTP server
* YAML parser
* JSON schema validator
* SQLite driver
* file watcher
* Azure DevOps REST client wrapper, custom preferred over large SDK

### 9.2 Components

```text
src/
  server/
    adoClient.ts
    syncEngine.ts
    validator.ts
    yamlStore.ts
    fileWatcher.ts
    db.ts
    audit.ts
    webhookServer.ts
    health.ts
    routes.ts

  frontend/
    index.html
    app.ts
    styles.css

  shared/
    types.ts
    constants.ts
```

### 9.3 Backend responsibilities

* Read YAML
* Validate YAML
* Watch file changes
* Store sync metadata
* Fetch ADO work items
* Create/update ADO work items
* Manage parent-child relations
* Receive webhook events
* Detect conflicts
* Record audit logs
* Serve frontend API

---

## 10. SQLite Schema

### 10.1 `work_item_cache`

```sql
CREATE TABLE work_item_cache (
  local_id TEXT PRIMARY KEY,
  ado_id INTEGER,
  work_item_type TEXT NOT NULL,
  yaml_path TEXT NOT NULL,
  yaml_document_index INTEGER NOT NULL DEFAULT 0,
  parent_local_id TEXT,
  parent_ado_id INTEGER,
  last_known_rev INTEGER,
  last_known_field_hash TEXT,
  last_known_relation_hash TEXT,
  last_remote_rev INTEGER,
  local_file_hash TEXT,
  sync_status TEXT NOT NULL,
  last_pulled_at TEXT,
  last_pushed_at TEXT,
  remote_changed_at TEXT,
  remote_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_work_item_cache_ado_id
  ON work_item_cache(ado_id)
  WHERE ado_id IS NOT NULL;
```

`last_known_rev`, `last_known_field_hash`, and `last_known_relation_hash` represent the last accepted local baseline from a successful pull or push. If a pull discovers a newer remote revision but the user declines YAML overwrite confirmation, those columns must remain unchanged and `last_remote_rev`, `remote_changed_at`, and `remote_checked_at` should record the observed remote state so the user can re-initiate the pull.

### 10.2 `audit_log`

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  local_id TEXT,
  ado_id INTEGER,
  work_item_type TEXT,
  yaml_path TEXT,
  before_rev INTEGER,
  after_rev INTEGER,
  before_hash TEXT,
  after_hash TEXT,
  success INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  request_summary TEXT,
  response_summary TEXT
);
```

### 10.3 `webhook_events`

```sql
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ado_id INTEGER,
  rev INTEGER,
  raw_payload TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);
```

### 10.4 `settings`

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 11. Azure DevOps Integration

### 11.1 Authentication

Use environment variable only.

Required env vars:

```bash
ADO_ORG=...
ADO_PROJECT=...
ADO_PAT=...
ADO_API_VERSION=7.1
ADO_WEBHOOK_SECRET=...
ADO_WORKSPACE_DIR=...
ADO_TEMPLATE_DIR=...
```

Do not persist PAT to disk.

### 11.2 REST API usage

Use Azure DevOps Work Item Tracking REST APIs.

Relevant operations:

* Get work item
* List work items by IDs
* Create work item
* Update work item
* Get work item updates/revisions
* Query children/relations with WIQL when needed
* List project work item types, fields, and states for metadata discovery

Work item creates and updates use JSON Patch with the `application/json-patch+json` media type. The official create and update endpoints accept patch operations against fields and relations. ([Microsoft Learn][1], [Microsoft Learn][2])

Read and diagnostics flows should use the work items list/get APIs for remote state and the updates API when the app needs revision delta details for conflict explanation. ([Microsoft Learn][3], [Microsoft Learn][4])

### 11.3 Create work item

For MVP, create operations apply only to child work items. Creating parent items is out of scope.

Creation should:

1. Validate parent exists and has an ADO ID.
2. Build JSON Patch document from YAML fields.
3. Add parent relation when creating child using the hierarchy relation type.
4. Submit create request.
5. Store returned ADO ID and revision.
6. Update YAML file with `metadata.adoId`.
7. Record audit entry.

Parent-child relations in Azure DevOps are represented through work item relations, which are manipulated through JSON Patch relation paths. Tree queries use the hierarchy link type `System.LinkTypes.Hierarchy-Forward`; when adding a parent relation from the child work item, use `System.LinkTypes.Hierarchy-Reverse` with the parent work item URL. ([Microsoft Learn][1], [Microsoft Learn][5])

### 11.4 Update work item

For MVP, update operations apply to the selected existing parent item and to existing displayed child work items.

Update should:

1. Fetch latest remote work item.
2. Compare latest `System.Rev` to cached `last_known_rev`.
3. If mismatch, block.
4. Build JSON Patch from YAML deltas.
5. Include a JSON Patch `test` operation for `/rev` before field/relation operations.
6. Submit update.
7. Store returned revision.
8. Record audit entry.

### 11.5 Conflict detection

Every remote `System.Rev` mismatch blocks push, regardless of which field changed. The Updates API can be used for diagnostics and conflict explanation, but MVP push safety is based on the revision mismatch itself.

Conflict diagnostics should highlight commonly relevant remote changes when available:

* Title
* State
* Parent
* Description
* Tags
* Remote item deleted

The UI does not need full merge tooling in MVP. It should block push and require pull.

---

## 12. Webhook Support

Azure DevOps webhooks can send JSON event payloads to a public endpoint for events such as work item updates. ([Microsoft Learn][8])

### Important constraint

A purely local app usually cannot receive ADO webhooks unless exposed through a reachable endpoint.

Therefore the spec should support one of these modes:

```text
Mode A: local webhook disabled
Mode B: local webhook through tunnel, for example ngrok/cloudflared
Mode C: polling fallback
```

MVP default mode is Mode A: local webhook disabled. The app may expose the webhook endpoint and health status, but correctness must come from manual refresh/pull and mandatory pre-push revision checks. Tunnel-based webhooks and polling can be added/configured later as advisory status mechanisms.

MVP should not depend exclusively on webhooks for correctness.

Conflict detection must still happen by fetching latest ADO revisions before push.

Webhook events are only an early warning/status mechanism.

### Required webhook behavior

When webhook event received:

1. Verify secret if configured.
2. Store raw payload.
3. Extract work item ID and revision.
4. Find matching cached item by ADO ID.
5. Mark item as `remote_changed` if webhook revision exceeds cached revision.
6. Update UI status icon.
7. Do not modify YAML automatically.
8. Do not push automatically.

---

## 13. Sync Engine

### 13.1 Push all displayed

Algorithm:

```text
1. Snapshot file hashes for all selected YAML files.
2. Parse YAML.
3. Validate schema.
4. Validate hierarchy.
5. Validate duplicate local IDs.
6. Validate duplicate titles among local YAML siblings with the same parent and same child work item type.
7. Resolve parent IDs and block any child whose required parent lacks an ADO ID.
8. Fetch latest remote state for all existing ADO IDs.
9. Block if any remote revision mismatch exists.
10. Detect parent changes. Allow them only when explicitly confirmed by the user and still protected by revision checks.
11. Build ordered operation list:
    a. update existing selected parent first if included
    b. create/update direct children next
12. Execute sequentially.
13. Stop on first failure.
14. After each success:
    a. update YAML metadata.adoId if newly created
    b. update SQLite revision/hash/status
    c. append audit log
15. If a file changed since initial snapshot, stop before operating on that file.
16. Show final summary.
```

### 13.2 Push individual row

Same as push all, but scoped to one work item and its required parent validation.

### 13.3 Pull all displayed

Algorithm:

```text
1. Fetch parent from ADO.
2. Fetch direct children.
3. For each returned work item:
   a. map to existing YAML by metadata.adoId or metadata.localId
   b. create YAML if missing; this is safe for newly pulled items and does not require confirmation
   c. if YAML already exists and the remote item changed after the last pull/successful sync, show a popup asking the user to confirm overwriting the local YAML
   d. update existing YAML only after popup confirmation
   e. if overwrite is declined, leave the YAML and last-known cache baseline unchanged but store the observed remote revision/status
   f. update cache metadata after any successful create/overwrite
4. Mark statuses as synced or conflict where appropriate.
5. Append audit log.
```

### 13.4 Pull individual row

Same as pull all, but only for the selected item.

---

## 14. Handling Destructive or Risky Operations

### Never do automatically

* Delete YAML files
* Delete ADO work items
* Force overwrite remote changes
* Change work item type
* Remove parent-child relationship
* Change parent relationship

### Require confirmation

* Removing parent-child link
* Changing parent
* Changing item type
* Replacing existing local YAML content during pull after the remote item changed
* Any force operation, if implemented later

Changing a parent relationship is allowed in MVP only as an explicitly confirmed user action. Confirmation does not bypass normal validation, parent type rules, parent ADO ID requirements, or remote revision checks.

For MVP, force push should be excluded.

---

## 15. Health / Status Panel

The app must expose a health/status panel showing:

```text
ADO auth: OK / failed
ADO project connection: OK / failed
Webhook listener: enabled / disabled / last event time
File watcher: active / failed
SQLite DB: OK / failed
Workspace directory: path + status
Template directory: path + status
Last sync summary: timestamp, success count, failure count, blocked count
```

Also include:

* Last ADO API error
* Last validation error count
* Last webhook event received
* Current app version
* Current configured project

---

## 16. Audit Requirements

Every pull/push must write audit records.

Minimum fields:

* Timestamp
* Operation ID
* YAML file path
* Work item type
* Local ID
* ADO ID
* Operation: create/update/pull
* Before revision
* After revision
* Before field hash
* After field hash
* Success/failure
* Error details
* Request summary
* Response summary

Audit request and response summaries should include changed field/relation names and before/after values where available. They must still redact PATs, authorization headers, and any other credentials.

Do not store PATs or full authorization headers in logs.

---

## 17. API Endpoints for Local App

Suggested local HTTP API:

```text
GET  /api/health
GET  /api/workspace/status
POST /api/workspace/refresh

GET  /api/view/parent/:localId
GET  /api/view/ado/:adoId

POST /api/validate
POST /api/pull/all
POST /api/pull/item
POST /api/push/all
POST /api/push/item

GET  /api/audit/recent
GET  /api/audit/item/:localId

POST /api/webhooks/ado
```

All write endpoints should return structured results:

```ts
type WorkItemSelector = {
  localId?: string;
  adoId?: number;
};

type PullOverwriteConfirmation = {
  localId?: string;
  adoId: number;
  yamlPath: string;
  yamlDocumentIndex: number;
  remoteRev: number;
  confirmed: true;
};

type ValidateRequest = {
  scope: "workspace" | "displayed" | "item";
  parent?: WorkItemSelector;
  item?: WorkItemSelector;
};

type PullAllRequest = {
  parent: WorkItemSelector;
  confirmations?: PullOverwriteConfirmation[];
};

type PullItemRequest = {
  item: WorkItemSelector;
  confirmation?: PullOverwriteConfirmation;
};

type PushAllRequest = {
  parent: WorkItemSelector;
  includeParent?: boolean;
  childLocalIds?: string[];
  confirmedParentChanges?: string[];
};

type PushItemRequest = {
  item: WorkItemSelector;
  confirmedParentChange?: boolean;
};

type ChangedValue = {
  path: string;
  before?: unknown;
  after?: unknown;
};

type ItemOperationResult = {
  localId?: string;
  adoId?: number;
  workItemType?: WorkItemType;
  yamlPath?: string;
  yamlDocumentIndex?: number;
  action:
    | "validate"
    | "pull"
    | "create"
    | "update"
    | "skip"
    | "block";
  status:
    | "success"
    | "blocked"
    | "failed"
    | "skipped"
    | "requires_confirmation";
  syncStatus?: SyncStatus;
  beforeRev?: number;
  afterRev?: number;
  cachedRev?: number;
  remoteRev?: number;
  changedValues?: ChangedValue[];
  validationIssues?: ValidationIssue[];
  confirmationRequired?: "overwrite_yaml" | "change_parent";
  errorCode?: string;
  errorMessage?: string;
};

type OperationResult = {
  operationId: string;
  status: "success" | "partial_failure" | "blocked" | "failed";
  summary: {
    validated: number;
    created: number;
    updated: number;
    pulled: number;
    blocked: number;
    failed: number;
  };
  items: ItemOperationResult[];
};
```

---

## 18. TypeScript Domain Types

```ts
type WorkItemType = "Epic" | "Feature" | "PBI" | "Enabler" | "Task";

type SyncStatus =
  | "local_only"
  | "synced"
  | "local_changed"
  | "remote_changed"
  | "conflict_blocked"
  | "validation_failed"
  | "push_failed"
  | "pull_failed"
  | "deleted_remotely";

type LocalWorkItem = {
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

type CachedWorkItem = {
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

type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  yamlPath?: string;
  localId?: string;
  field?: string;
};
```

---

## 19. Acceptance Tests

### 19.1 MVP must-pass flows

* Validate YAML against template schema
* Validate and independently operate on multiple YAML documents in one file
* Display one parent and direct children
* Pull parent and children from ADO
* Create YAML file when pulling parent/children if missing
* Require popup confirmation before pull overwrites existing local YAML after remote change
* Leave YAML and last-known cache baseline unchanged when pull overwrite is declined
* Update existing selected parent
* Push new children under existing parent
* Update existing children from YAML deltas
* Block push when remote revision changed
* Allow parent change only after explicit confirmation and successful revision check
* Record audit entry for each operation
* Show health/status panel
* Support manual retry after failed push

### 19.2 Required test data shape

Support at minimum:

* 1 Epic with 15 Features
* 1 Feature with 20 PBIs
* 1 Feature with 5 Enablers
* 1 PBI with 30 Tasks
* 1 Enabler with 10 Tasks
* Mixed create and update rows in same file set
* Nested directories under workspace

### 19.3 Validation failure tests

Must fail on:

* Unknown fields
* Missing required fields
* Invalid enum values
* Invalid parent type
* Parent ID missing for Feature, PBI, Enabler, or Task
* Duplicate local aliases
* Duplicate local titles under same parent and same child work item type

### 19.4 Conflict tests

Must block push when:

* Remote title changed after local pull
* Remote state changed after local pull
* Remote parent changed after local pull
* Remote description changed after local pull
* Remote item deleted
* YAML file changed while push is in progress

---

## 20. Recommended MVP Build Order

### Phase 1: Local model and validation

Build:

* Workspace scanner
* YAML parser
* Template parser
* Schema validation
* Hierarchy validation
* Multi-document YAML indexing
* SQLite cache
* Minimal UI showing parent + children

Exit criteria:

* Can load workspace
* Can validate files
* Can display parent and direct children

### Phase 2: ADO read/pull

Build:

* PAT auth
* Project/process/work item metadata discovery
* Fetch work item by ID
* Fetch parent/child relations
* Pull parent and children
* Create YAML file if missing
* Cache revisions

Exit criteria:

* Can pull a parent and its direct children into YAML

### Phase 3: Push engine

Build:

* Delta detection
* Prevalidation
* Revision check
* JSON Patch generation
* Sequential push
* Stop-on-first-failure
* Audit logging

Exit criteria:

* Can update an existing parent and create/update children safely under that parent

### Phase 4: Conflict and webhook status

Build:

* Webhook endpoint
* Remote-changed status
* Push blocking
* Health panel
* Last sync summary

Exit criteria:

* Remote update blocks local push until pull

---

## 21. Key Blind Spots / Risks

### Webhooks do not remove the need for pre-push revision checks

Webhook delivery can be delayed, unavailable, or impossible without a public endpoint. Treat webhooks as advisory status, not correctness enforcement.

### ADO is not transaction-safe across multiple work items

The app must be honest that “transaction-like” means:

```text
prevalidate everything
push sequentially
stop on first failure
record recovery information
```

It does **not** mean atomic rollback.

### YAML authority can conflict with pull behavior

Because YAML is authoritative locally, pulling remote changes must not silently overwrite existing local YAML. Once an item exists locally, overwriting it from ADO after a remote change requires explicit popup confirmation.

### Minimal frontend is good, but not at the expense of conflict visibility

The UI can be lightweight, but sync state must be extremely visible. A tiny UI with unclear conflict indicators would be dangerous.

---

## 22. One-Sentence Implementation Summary

Build a local TypeScript web app where YAML files define intended Azure DevOps work item state, SQLite tracks ADO revision/sync metadata, the UI displays one parent and its direct children, and all writes are manually triggered, prevalidated, revision-checked, sequentially pushed, audited, and blocked on remote conflicts.

[1]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1
[2]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1
[3]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/updates/list?view=azure-devops-rest-7.1
[4]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/list?view=azure-devops-rest-7.1
[5]: https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax?view=azure-devops
[6]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/list?view=azure-devops-rest-7.1
[7]: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/fields/list?view=azure-devops-rest-7.1
[8]: https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks?view=azure-devops
[9]: https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/scrum-process-workflow?view=azure-devops
[10]: https://learn.microsoft.com/en-us/rest/api/azure/devops/core/projects/get?view=azure-devops-rest-7.1
