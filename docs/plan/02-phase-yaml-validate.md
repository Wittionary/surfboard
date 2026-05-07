# Phase 2 — YAML Model And Validation

**Phase goal** — Implement local workspace scanning, multi-document YAML parsing, template validation, hierarchy validation, canonical hashing, cache indexing, file watching, validation APIs, and the first data-backed UI view without ADO access.

**Exit criteria**
- Running `bun run verify:phase2` passes Phase 1 checks plus local YAML validation tests.
- `POST /api/workspace/refresh` scans templates and multi-document work item YAML.
- `POST /api/validate` returns grouped file/document validation results.
- The UI displays one local parent and its direct local children with validation/status indicators.

**Out of scope for this phase**
- ADO REST calls and metadata discovery.
- Pulling or pushing work items.
- Webhook handling.
- ADO audit records.

## Task 2.1 — Implement Multi-document YAML Store

**Goal:** The app can read, index, and update individual YAML work item documents.

**Deliverables:**
- `src/server/yamlStore.ts` exports scan, parse, read, and write-by-document-index behavior for spec §5.2 and §5.3.
- `tests/fixtures/yaml/multi-doc.yaml` contains at least three work item documents.
- `tests/server/yamlStore.test.ts` covers invalid YAML, document indexes, `metadata.localId`, and sibling document preservation.

**Out of scope here:**
- Template validation, hierarchy validation, and SQLite cache writes.

**Verify:**
```bash
bun test tests/server/yamlStore.test.ts
```
Expected: Multi-document YAML parsing and write-by-index behavior pass.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.2 — Implement Template Loading

**Goal:** Local templates load from `ADO_TEMPLATE_DIR` and map to work item kinds.

**Deliverables:**
- `src/server/templateStore.ts` exports template loading and lookup by work item kind for spec §6.
- `tests/fixtures/templates/` contains Epic, Feature, PBI, Enabler, and Task templates.
- `tests/server/templateStore.test.ts` covers missing, duplicate, and malformed template cases.

**Out of scope here:**
- Work item document validation and ADO metadata merging.

**Verify:**
```bash
bun test tests/server/templateStore.test.ts
```
Expected: Template loading tests pass for all five MVP work item types.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.3 — Implement Schema Validation

**Goal:** Work item YAML validates against the Kubernetes-like envelope and local template rules.

**Deliverables:**
- `src/server/validator.ts` validates top-level keys, `apiVersion`, `kind`, `metadata`, `spec.fields`, `spec.tags`, required fields, optional fields, enums, field types, and unknown fields for spec §6 and §7.
- `tests/server/schemaValidation.test.ts` covers required fields, unknown fields, invalid enum values, invalid types, and tag allowance.
- `src/shared/types.ts` validation issue codes are stable enough for UI display.

**Out of scope here:**
- Parent hierarchy checks and duplicate workspace checks.

**Verify:**
```bash
bun test tests/server/schemaValidation.test.ts
```
Expected: Schema validation tests pass and return file/document-aware issues.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.4 — Implement Workspace Scanner And Cache Indexing

**Goal:** Workspace refresh indexes local work item documents in SQLite without storing content.

**Deliverables:**
- `src/server/workspace.ts` scans `ADO_WORKSPACE_DIR` recursively and excludes `ADO_TEMPLATE_DIR`.
- `src/server/db.ts` adds cache upsert/query helpers for `local_id`, `yaml_path`, `yaml_document_index`, parent metadata, and local file hashes.
- `tests/server/workspaceScanner.test.ts` verifies multi-document indexing and that `spec.fields` content is not stored in SQLite.

**Out of scope here:**
- Remote revision metadata and ADO ID updates from pull.

**Verify:**
```bash
bun test tests/server/workspaceScanner.test.ts
```
Expected: Workspace scanner indexes local documents and stores metadata only.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.5 — Implement Hierarchy And Duplicate Validation

**Goal:** Local validation enforces parent rules and duplicate blockers.

**Deliverables:**
- `src/server/validator.ts` enforces the parent matrix from spec §5.4.
- Workspace validation blocks duplicate `metadata.localId` across the workspace.
- Workspace validation blocks normalized duplicate titles only among local siblings with the same parent and same child work item type per spec §7.
- `tests/server/hierarchyValidation.test.ts` covers parent matrix and duplicate blocker scenarios.

**Out of scope here:**
- Remote parent existence and remote duplicate checks.

**Verify:**
```bash
bun test tests/server/hierarchyValidation.test.ts
```
Expected: Hierarchy and duplicate validation tests pass.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.6 — Implement Canonical Hashing And Local Status

**Goal:** The app distinguishes real content changes from YAML formatting changes.

**Deliverables:**
- `src/server/hash.ts` exports canonical field, relation, and file/document hash helpers for spec §7.
- `src/server/workspace.ts` derives `local_only`, `synced`, and `local_changed` from current hashes and cache baselines.
- `tests/server/hash.test.ts` proves comments and key ordering do not change field/relation hashes.

**Out of scope here:**
- Remote change statuses and conflict diagnostics.

**Verify:**
```bash
bun test tests/server/hash.test.ts
```
Expected: Canonical hash tests pass for equivalent YAML content.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.7 — Add Local Workspace APIs

**Goal:** The backend exposes local refresh, status, validate, and view endpoints.

**Deliverables:**
- `src/server/routes.ts` implements `GET /api/workspace/status`, `POST /api/workspace/refresh`, `POST /api/validate`, and `GET /api/view/parent/:localId`.
- `src/server/routes.ts` returns spec §17 result shapes for validation operations.
- `tests/server/localRoutes.test.ts` covers workspace, displayed, and item validation scopes.

**Out of scope here:**
- Pull, push, ADO-backed view by ADO ID, and audit endpoints.

**Verify:**
```bash
bun test tests/server/localRoutes.test.ts
```
Expected: Local API routes pass against fixture workspaces.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.8 — Add File Watcher

**Goal:** Local file changes update cache and validation state without syncing.

**Deliverables:**
- `src/server/fileWatcher.ts` wraps `chokidar` and debounces workspace refresh.
- `src/server/health.ts` reports watcher active/failed status for spec §15.
- `tests/server/fileWatcher.test.ts` uses temp files to prove file changes update local status only.

**Out of scope here:**
- Automatic pull, automatic push, and retry behavior.

**Verify:**
```bash
bun test tests/server/fileWatcher.test.ts
```
Expected: Watcher tests pass and no sync route is called by file changes.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 2.9 — Render Local Parent And Child Grid

**Goal:** The UI displays local parent and direct child rows from backend APIs.

**Deliverables:**
- `src/frontend/app.ts` calls local workspace, validation, and parent view APIs.
- `src/frontend/styles.css` renders the parent hero, child grid, status labels, actions, and footer from spec §8.
- `tests/frontend/localView.test.ts` verifies parent header, direct child rows, and validation/status rendering from mocked API data.

**Out of scope here:**
- Pull/push buttons, confirmation popups, and ADO-backed statuses.

**Verify:**
```bash
bun test tests/frontend/localView.test.ts
```
Expected: Frontend local view tests pass.

**Done when:** Verify command passes and `bun run build` is clean.

## Task 2.10 — Add Phase 2 Verification

**Goal:** Phase 2 has a single command proving local YAML validation behavior.

**Deliverables:**
- `package.json` updates `verify:phase2` to run Phase 1 verification plus YAML, template, workspace, watcher, route, and frontend local-view tests.
- `scripts/smoke-local-validation.ts` verifies refresh, validate, and parent view against fixtures.
- `tests/acceptance/localValidation.test.ts` covers the spec §19.3 validation failure cases that require no ADO.

**Out of scope here:**
- ADO fixture tests and sync behavior.

**Verify:**
```bash
bun run verify:phase2
```
Expected: Phase 1 checks and all local validation checks pass.

**Done when:** Verify command passes and the task is committed on `main`.

## Phase verification

```bash
bun run verify:phase2
```
Expected: The app scans, validates, indexes, watches, and displays local YAML work items without ADO access.

