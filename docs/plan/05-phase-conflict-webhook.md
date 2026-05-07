# Phase 5 — Conflict, Webhook, Health, And Acceptance

**Phase goal** — Complete remote-change visibility, advisory webhook storage, health/status panel, audit browsing, acceptance fixtures, and final MVP verification while preserving pre-push revision checks as the only correctness mechanism.

**Exit criteria**
- Remote revision drift marks items blocked and prevents push.
- Webhook events are stored and can mark cached items as `remote_changed` without modifying YAML.
- The health panel shows ADO, watcher, SQLite, workspace, template, webhook, and sync summary status.
- Audit recent/item APIs and UI access are usable.
- Running `bun run verify:mvp` passes the local MVP acceptance suite without real ADO mutation.

**Out of scope for this phase**
- Tunnel setup automation.
- Background polling as default mode.
- Force operations.
- Multi-project support.

## Task 5.1 — Implement Remote-change Diagnostics

**Goal:** Manual refresh can detect and explain remote revision drift before push.

**Deliverables:**
- `src/server/syncEngine.ts` exposes remote refresh/status behavior using latest ADO revisions and updates API diagnostics.
- `src/server/db.ts` updates `last_remote_rev`, `remote_changed_at`, and `remote_checked_at` without changing accepted baseline.
- `tests/server/remoteChangeStatus.test.ts` covers title, state, parent, description, tags, and deleted item diagnostics.

**Out of scope here:**
- Auto-polling, automatic pull, and automatic push.

**Verify:**
```bash
bun test tests/server/remoteChangeStatus.test.ts
```
Expected: Remote drift produces `remote_changed` or `deleted_remotely` and blocks push.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 5.2 — Implement Advisory Webhook Endpoint

**Goal:** Webhook events are stored and can mark cached items as remote changed.

**Deliverables:**
- `src/server/webhookServer.ts` verifies `ADO_WEBHOOK_SECRET` when configured and stores raw payloads in `webhook_events`.
- `src/server/routes.ts` implements `POST /api/webhooks/ado` without modifying YAML or triggering sync.
- `tests/server/webhook.test.ts` covers secret verification, event storage, revision extraction, and cache status update.

**Out of scope here:**
- Public tunnel setup and webhook-dependent correctness.

**Verify:**
```bash
bun test tests/server/webhook.test.ts
```
Expected: Webhook tests store events, mark remote change only when appropriate, and never modify YAML.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 5.3 — Complete Health And Status Panel

**Goal:** The frontend exposes full operational status from spec §15.

**Deliverables:**
- `src/server/health.ts` includes ADO auth, project connection, webhook, watcher, SQLite, workspace, template directory, last sync summary, last ADO error, validation count, app version, and configured project.
- `src/frontend/app.ts` renders the health panel and footer summary.
- `tests/frontend/healthPanel.test.ts` covers healthy and degraded status rendering.

**Out of scope here:**
- New sync behavior or background checks.

**Verify:**
```bash
bun test tests/frontend/healthPanel.test.ts
```
Expected: Health panel renders all required status fields for healthy and degraded fixtures.

**Done when:** Verify command passes and `bun run build` is clean.

## Task 5.4 — Implement Audit APIs And UI Access

**Goal:** Users can inspect recent and item-specific audit records.

**Deliverables:**
- `src/server/routes.ts` implements `GET /api/audit/recent` and `GET /api/audit/item/:localId`.
- `src/frontend/app.ts` supports “View last audit entry” per row.
- `tests/server/auditRoutes.test.ts` verifies redacted summaries and changed values are returned.

**Out of scope here:**
- Full audit search, export, and retention management.

**Verify:**
```bash
bun test tests/server/auditRoutes.test.ts
```
Expected: Audit route tests return redacted recent and item-specific audit data.

**Done when:** Verify command passes and `bun run build` is clean.

## Task 5.5 — Add MVP Acceptance Fixtures

**Goal:** MVP acceptance scenarios are covered by repeatable fixture tests.

**Deliverables:**
- `tests/fixtures/acceptance/` covers spec §19.1 through §19.4 with local YAML, templates, ADO responses, update responses, deleted responses, and webhook payloads.
- `tests/acceptance/mvp.test.ts` validates local, pull, push, conflict, audit, and health flows through HTTP APIs.
- Fixtures include the scale shapes required by spec §19.2.

**Out of scope here:**
- Live ADO write smoke beyond the guarded script from Phase 4.

**Verify:**
```bash
bun test tests/acceptance/mvp.test.ts
```
Expected: Acceptance tests pass without network access.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 5.6 — Add Final MVP Smoke Command

**Goal:** A developer can verify the MVP locally without real ADO mutation.

**Deliverables:**
- `scripts/smoke-mvp.ts` verifies health, workspace refresh, validation, parent view, pull fixture mode, push fixture mode, and audit routes.
- `package.json` adds `verify:mvp` and wires `verify:phase5`.
- `README.md` documents setup, env vars, safe ADO smoke commands, and no-force safety notes.

**Out of scope here:**
- Deployment packaging and CI setup.

**Verify:**
```bash
bun run verify:mvp
```
Expected: Full local MVP smoke passes without mutating real ADO.

**Done when:** Verify command passes and `bun run check` is clean.

## Task 5.7 — Final Safety Review

**Goal:** The implementation is checked against the spec and `CLAUDE.md` safety contract.

**Deliverables:**
- `tests/acceptance/safety.test.ts` asserts no automatic sync, no force operations, no delete operations, and required revision-test behavior.
- `README.md` links to spec sections for authority model, safe ADO smoke, and pause triggers.
- `package.json` includes the safety acceptance test in `verify:mvp`.

**Out of scope here:**
- New features or expanded MVP scope.

**Verify:**
```bash
bun test tests/acceptance/safety.test.ts
```
Expected: Safety acceptance tests pass for all hard invariants.

**Done when:** Verify command passes and `bun run verify:mvp` is clean.

## Phase verification

```bash
bun run verify:phase5
```
Expected: All unit, route, frontend, acceptance, build, and MVP smoke checks pass; live ADO write smoke remains opt-in only.

