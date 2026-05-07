# Phase 3 — ADO Read And Pull

**Phase goal** — Add ADO auth checks, metadata discovery, read APIs, parent/child pull, YAML creation, overwrite confirmation, cache baseline updates, pull audit records, and pull UI actions.

**Exit criteria**
- Running `bun run verify:phase3` passes Phase 2 checks plus fixture-backed ADO read/pull tests.
- Health reports ADO auth/project status when env vars are present.
- Pulling safe parent `221835` can create missing local YAML.
- Existing YAML is overwritten only after explicit confirmation when remote changed.
- Declined overwrite leaves YAML and `last_known_*` baseline unchanged.

**Out of scope for this phase**
- Creating or updating ADO work items.
- Push prevalidation and JSON Patch generation.
- Webhook advisory status.
- Reparenting behavior.

## Task 3.1 — Implement ADO Client Foundation

**Goal:** The server can make authenticated, redacted ADO REST requests.

**Deliverables:**
- `src/server/adoClient.ts` builds URLs from spec §11.1 config and sends PAT auth headers without logging secrets.
- `src/server/adoClient.ts` supports JSON responses, JSON Patch media type, API versioning, and structured errors.
- `tests/server/adoClient.test.ts` mocks fetch and verifies URL construction, status handling, and redaction.

**Out of scope here:**
- Work item-specific read, metadata, pull, or push methods.

**Verify:**
```bash
bun test tests/server/adoClient.test.ts
```
Expected: ADO client tests pass and no auth value appears in errors or logs.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.2 — Discover ADO Metadata

**Goal:** Workspace refresh can discover and cache project work item metadata.

**Deliverables:**
- `src/server/adoMetadata.ts` fetches project capabilities, work item types, fields, and states per spec §6.1 and §11.2.
- `src/server/db.ts` stores metadata snapshots in SQLite `settings` with refresh timestamps.
- `tests/server/adoMetadata.test.ts` uses recorded fixtures for project, work item types, and fields.

**Out of scope here:**
- Enforcing remote metadata during push.

**Verify:**
```bash
bun test tests/server/adoMetadata.test.ts
```
Expected: Metadata discovery maps fixture data and caches it in `settings`.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.3 — Add ADO Health Checks

**Goal:** Health reports ADO auth and project connectivity without mutating ADO.

**Deliverables:**
- `src/server/health.ts` checks ADO auth/project status using read-only calls when config is present.
- `src/server/health.ts` reports missing ADO config as degraded while keeping local validation available.
- `tests/server/adoHealth.test.ts` covers healthy, auth failed, project failed, and missing config cases.

**Out of scope here:**
- Pulling work items and metadata refresh side effects.

**Verify:**
```bash
bun test tests/server/adoHealth.test.ts
```
Expected: ADO health tests return the expected healthy/degraded statuses.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.4 — Read Work Items And Direct Children

**Goal:** The ADO client can fetch one work item and its direct children.

**Deliverables:**
- `src/server/adoClient.ts` exports `getWorkItem`, `getWorkItems`, `getUpdates`, and `getDirectChildren`.
- `src/server/adoClient.ts` uses WIQL hierarchy links for direct children per spec §11.2.
- `tests/server/adoRead.test.ts` maps fixtures for parent `221835`, children, updates, and deleted item responses.

**Out of scope here:**
- YAML writing and cache mutation.

**Verify:**
```bash
bun test tests/server/adoRead.test.ts
```
Expected: ADO read methods normalize fixture responses for parent and direct children.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.5 — Map ADO Items To YAML Documents

**Goal:** Remote ADO work items convert to canonical local YAML documents.

**Deliverables:**
- `src/server/adoMapper.ts` converts ADO IDs, revisions, fields, tags, and parent relations into `LocalWorkItem`.
- `src/server/adoMapper.ts` handles `System.Tags` and `spec.tags` conversion from spec §5.3.
- `tests/server/adoMapper.test.ts` covers Epic root, Feature/PBI/Enabler/Task parent mapping, tags, and missing optional fields.

**Out of scope here:**
- Writing mapped YAML documents to disk.

**Verify:**
```bash
bun test tests/server/adoMapper.test.ts
```
Expected: ADO-to-YAML mapping tests pass for all MVP work item types.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.6 — Implement Pull Create-missing Flow

**Goal:** Pulling creates YAML files for remote work items missing locally.

**Deliverables:**
- `src/server/syncEngine.ts` implements pull parent/direct-children create-missing behavior from spec §4.2 and §13.3.
- `src/server/yamlStore.ts` writes new files under deterministic work item type folders.
- `tests/server/pullCreateMissing.test.ts` verifies YAML creation, cache baseline updates, and metadata-only SQLite writes.

**Out of scope here:**
- Existing YAML overwrite confirmation and push behavior.

**Verify:**
```bash
bun test tests/server/pullCreateMissing.test.ts
```
Expected: Pull creates missing YAML and accepted cache baselines from fixtures.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.7 — Implement Pull Overwrite Confirmation

**Goal:** Pull never overwrites existing YAML after remote change without explicit confirmation.

**Deliverables:**
- `src/server/syncEngine.ts` returns `requires_confirmation` with `confirmationRequired: "overwrite_yaml"` when spec §8.6 confirmation is required.
- `src/server/syncEngine.ts` preserves YAML and `last_known_*` when overwrite is declined while updating remote-observed metadata from spec §4.2.
- `tests/server/pullOverwriteConfirmation.test.ts` covers declined and confirmed overwrite paths.

**Out of scope here:**
- Frontend popup rendering.

**Verify:**
```bash
bun test tests/server/pullOverwriteConfirmation.test.ts
```
Expected: Decline and confirm paths match spec §4.2, §8.6, and §13.3.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.8 — Add Pull Routes And Pull Audit

**Goal:** Pull operations are available over HTTP and recorded in audit logs.

**Deliverables:**
- `src/server/routes.ts` implements `POST /api/pull/all` and `POST /api/pull/item` using spec §17 request/result shapes.
- `src/server/audit.ts` writes pull success, blocked, and failed records with redacted summaries per spec §16.
- `tests/server/pullRoutes.test.ts` covers create, confirmation-required, confirmed overwrite, declined overwrite, and failure responses.

**Out of scope here:**
- Push audit records and JSON Patch summaries.

**Verify:**
```bash
bun test tests/server/pullRoutes.test.ts
```
Expected: Pull route tests return correct `OperationResult` values and audit rows.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 3.9 — Add Pull UI Actions

**Goal:** Users can pull displayed or selected items and confirm or cancel YAML overwrite.

**Deliverables:**
- `src/frontend/app.ts` wires Pull all, Pull selected, and refresh actions to pull APIs.
- `src/frontend/app.ts` renders the spec §8.6 confirmation popup with cancel as the default action.
- `tests/frontend/pullUi.test.ts` verifies pull actions, confirmation fields, cancel default, and confirmed retry.

**Out of scope here:**
- Push actions and parent-change confirmation.

**Verify:**
```bash
bun test tests/frontend/pullUi.test.ts
```
Expected: Pull UI tests pass for create, confirmation, cancel, and confirm flows.

**Done when:** Verify command passes and `bun run build` is clean.

## Task 3.10 — Add Guarded ADO Read Smoke

**Goal:** A developer can verify read-only ADO integration against safe parent `221835`.

**Deliverables:**
- `scripts/smoke-ado-read.ts` fetches parent `221835`, direct children, and metadata without mutation.
- `package.json` adds `smoke:ado-read` and wires `verify:phase3`.
- The smoke script refuses to run when org, project, or parent differs from `docs/plan/00-decisions.md`.

**Out of scope here:**
- Any ADO create, update, or delete operation.

**Verify:**
```bash
bun run smoke:ado-read
```
Expected: Script prints parent `221835` summary and child count, or a structured env/auth failure.

**Done when:** Verify command passes when credentials are available and `bun run check` is clean.

## Phase verification

```bash
bun run verify:phase3
```
Expected: Phase 2 checks plus fixture-backed ADO metadata, read, pull, audit, and UI tests pass; live read smoke reports success or environment-gated failure.

