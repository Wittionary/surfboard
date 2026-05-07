# Phase 4 — Push Engine

**Phase goal** — Implement safe ADO create/update JSON Patch generation, pre-push revision checks, dependency-ordered sequential push, stop-on-first-failure, parent-change confirmation, write audit redaction, push APIs, and push UI actions.

**Exit criteria**
- Existing selected parent updates only when cached and remote revisions match.
- New children can be created under existing parent `221835`.
- Existing children update only when cached and remote revisions match.
- Every update JSON Patch includes a `/rev` test operation.
- Batch push stops on first failure and records audit rows for attempted operations.

**Out of scope for this phase**
- Parent work item creation.
- Force push and automatic retry.
- ADO work item deletion.
- Webhook-driven status.

## Task 4.1 — Build JSON Patch Generator

**Goal:** Local YAML deltas become safe ADO JSON Patch documents.

**Deliverables:**
- `src/server/patchBuilder.ts` exports create and update patch builders for fields, tags, and relations per spec §11.3 and §11.4.
- `src/server/patchBuilder.ts` includes a `/rev` `test` operation before update operations.
- `tests/server/patchBuilder.test.ts` covers parent updates, child creates, child updates, tags, and hierarchy relations.

**Out of scope here:**
- Submitting patches to ADO.

**Verify:**
```bash
bun test tests/server/patchBuilder.test.ts
```
Expected: Patch generation tests pass and every update patch starts with `/rev` test.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.2 — Implement Push Prevalidation

**Goal:** Push blocks before mutation when local safety checks fail.

**Deliverables:**
- `src/server/syncEngine.ts` performs full push-set validation from spec §4.3 and §13.1.
- `src/server/syncEngine.ts` blocks missing cached revisions, invalid parents, missing parent ADO IDs, validation failures, and changed files.
- `tests/server/pushPrevalidation.test.ts` covers every push-relevant hard blocker from spec §7.

**Out of scope here:**
- Fetching remote revisions and calling ADO writes.

**Verify:**
```bash
bun test tests/server/pushPrevalidation.test.ts
```
Expected: Unsafe push sets are blocked before any ADO write mock is called.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.3 — Add Remote Revision And Deletion Checks

**Goal:** Existing item pushes block on remote revision drift or deletion.

**Deliverables:**
- `src/server/syncEngine.ts` fetches latest remote state for every existing ADO ID before push per spec §11.5.
- `src/server/syncEngine.ts` blocks every `System.Rev` mismatch and deleted remote item.
- `tests/server/pushRemoteSafety.test.ts` covers matching revision, mismatched revision, and deleted item responses.

**Out of scope here:**
- Submitting successful update patches.

**Verify:**
```bash
bun test tests/server/pushRemoteSafety.test.ts
```
Expected: Remote revision drift and deletion block push before mutation.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.4 — Implement Child Create Operation

**Goal:** New child YAML documents can be created in ADO under an existing parent.

**Deliverables:**
- `src/server/syncEngine.ts` creates child work items only when a valid parent ADO ID exists.
- `src/server/syncEngine.ts` updates `metadata.adoId`, accepted cache baseline, hashes, and status after ADO success.
- `tests/server/pushCreateChild.test.ts` covers PBI under Feature and Task under PBI or Enabler.

**Out of scope here:**
- Existing item updates and parent creation.

**Verify:**
```bash
bun test tests/server/pushCreateChild.test.ts
```
Expected: Child create tests update YAML and cache only after ADO success.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.5 — Implement Existing Item Updates

**Goal:** Existing parent and child items update only through revision-protected patches.

**Deliverables:**
- `src/server/syncEngine.ts` updates selected parent and existing direct children per spec §11.4.
- `src/server/syncEngine.ts` updates cache baseline and hashes only after successful ADO response.
- `tests/server/pushUpdate.test.ts` verifies parent update, child update, no-op update, and ADO failure handling.

**Out of scope here:**
- Batch ordering and parent-change confirmation.

**Verify:**
```bash
bun test tests/server/pushUpdate.test.ts
```
Expected: Existing item update tests pass and no patch without `/rev` test is submitted.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.6 — Implement Batch Ordering And Stop-on-first-failure

**Goal:** Push all displayed executes in deterministic dependency order and stops at the first failure.

**Deliverables:**
- `src/server/syncEngine.ts` orders selected parent update before child create/update operations.
- `src/server/syncEngine.ts` snapshots file hashes and stops before operating on a changed file.
- `tests/server/pushBatch.test.ts` proves parent-first ordering, changed-file blocking, and no later operations after failure.

**Out of scope here:**
- Frontend summary rendering.

**Verify:**
```bash
bun test tests/server/pushBatch.test.ts
```
Expected: Batch tests pass for ordering, changed-file blocking, and stop-on-first-failure.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.7 — Implement Parent-change Confirmation

**Goal:** Reparenting is allowed only after explicit confirmation and normal safety checks.

**Deliverables:**
- `src/server/syncEngine.ts` detects parent relation changes and returns `requires_confirmation` unless confirmed.
- `src/server/syncEngine.ts` still enforces parent type, parent ADO ID, and remote revision checks after confirmation.
- `tests/server/parentChangeConfirmation.test.ts` covers unconfirmed block and confirmed relation patch.

**Out of scope here:**
- Removing parent-child links without replacement.

**Verify:**
```bash
bun test tests/server/parentChangeConfirmation.test.ts
```
Expected: Parent-change confirmation tests pass without bypassing revision checks.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.8 — Complete Push Audit Redaction

**Goal:** Every attempted push operation has a redacted audit record with changed values.

**Deliverables:**
- `src/server/audit.ts` records create, update, block, and failure rows per spec §16.
- `src/server/audit.ts` includes changed field/relation names and before/after values when available.
- `tests/server/auditRedaction.test.ts` proves PATs, auth headers, and raw tokens never appear in logs or audit rows.

**Out of scope here:**
- Audit browsing UI and retention management.

**Verify:**
```bash
bun test tests/server/auditRedaction.test.ts
```
Expected: Audit tests pass and credential strings are absent from serialized audit data.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.9 — Add Push Routes

**Goal:** Push behavior is exposed through local HTTP APIs.

**Deliverables:**
- `src/server/routes.ts` implements `POST /api/push/all` and `POST /api/push/item`.
- `src/server/routes.ts` accepts `PushAllRequest` and `PushItemRequest` from spec §17.
- `tests/server/pushRoutes.test.ts` covers success, blocked, failed, and requires-confirmation response shapes.

**Out of scope here:**
- Frontend push buttons and hotkeys.

**Verify:**
```bash
bun test tests/server/pushRoutes.test.ts
```
Expected: Push routes return correct `OperationResult` shapes for major outcomes.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 4.10 — Add Push UI Actions And Hotkeys

**Goal:** Users can trigger push actions from buttons and non-conflicting hotkeys.

**Deliverables:**
- `src/frontend/app.ts` wires Push all, Push selected, Validate all, Validate selected, and parent-change confirmation.
- `src/frontend/app.ts` implements hotkeys from spec §8.7.
- `tests/frontend/pushUi.test.ts` covers push buttons, hotkeys, blocked states, and confirmation flow.

**Out of scope here:**
- Webhook remote-change status and final health panel.

**Verify:**
```bash
bun test tests/frontend/pushUi.test.ts
```
Expected: Push UI tests pass for actions, hotkeys, blocked states, and confirmations.

**Done when:** Verify command passes and `bun run build` is clean.

## Task 4.11 — Add Guarded ADO Write Smoke

**Goal:** The real ADO write path can be manually verified only under safe parent `221835`.

**Deliverables:**
- `scripts/smoke-ado-write.ts` creates one uniquely named child under `221835`, updates it once, and never touches pre-existing disallowed items.
- `package.json` adds `smoke:ado-write` and wires `verify:phase4` to skip this smoke unless explicitly enabled.
- The script requires `SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes` and refuses to run for any other parent.

**Out of scope here:**
- Automatic execution of live writes in `bun run check`.

**Verify:**
```bash
SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes bun run smoke:ado-write
```
Expected: Script creates and updates one app-owned child under `221835`, then prints the new ADO ID.

**Done when:** Verify command passes with explicit env approval and `bun run check` is clean.

## Phase verification

```bash
bun run verify:phase4
```
Expected: Phase 3 checks plus fixture-backed push tests pass; live write smoke is skipped unless explicitly enabled.

