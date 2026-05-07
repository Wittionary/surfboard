# Phase 1 — Bootstrap

**Phase goal** — Establish the Bun/TypeScript project skeleton, configuration loader, SQLite migration foundation, Fastify app, static frontend shell, and baseline verification commands without implementing YAML validation or ADO behavior.

**Exit criteria**
- Running `bun run dev` boots the server on `127.0.0.1:3000`.
- Running `curl http://127.0.0.1:3000/api/health` returns structured app, config, workspace, template, and SQLite status.
- Running `bun run check` runs typecheck and tests.
- Running `bun run verify:phase1` confirms the app can boot, migrate SQLite, serve health, and build frontend assets.

**Out of scope for this phase**
- YAML parsing and validation.
- ADO REST calls.
- Pull, push, or webhook behavior.
- Audit records beyond schema creation.

## Task 1.1 — Initialize Bun Project

**Goal:** The repository has a pinned Bun TypeScript project skeleton with repeatable scripts.

**Deliverables:**
- `package.json` defines exact dependencies from `docs/plan/00-decisions.md`, `"type": "module"`, and scripts `dev`, `build`, `typecheck`, `test`, `check`, and `verify:phase1`.
- `tsconfig.json` enables strict ESM TypeScript with Bun types and `noEmit`.
- `bun.lock` is generated from the pinned dependency set.

**Out of scope here:**
- Application routes, database logic, and frontend behavior.

**Verify:**
```bash
bun run typecheck
```
Expected: TypeScript exits cleanly after project initialization.

**Done when:** Verify command passes and the task is committed on `main`.

## Task 1.2 — Create Source Layout And Shared Contracts

**Goal:** The planned app modules exist and shared domain types compile.

**Deliverables:**
- `src/shared/types.ts` exports the domain, request, result, and validation issue types from spec §17 and §18.
- `src/shared/constants.ts` exports allowed work item kinds, parent matrix, sync statuses, API version, and hotkey constants from spec §5 and §8.
- Stub files exist under `src/server/` and `src/frontend/` matching the component layout in spec §9.2.

**Out of scope here:**
- Runtime logic, validators, ADO calls, and persistence behavior.

**Verify:**
```bash
bun run typecheck
```
Expected: Shared contracts and stubs compile under strict TypeScript.

**Done when:** Verify command passes and the task is committed on `main`.

## Task 1.3 — Implement Environment Configuration

**Goal:** The app loads and reports required configuration without persisting secrets.

**Deliverables:**
- `src/server/config.ts` exports `loadConfig()` and redacted public config behavior for spec §11.1.
- `tests/server/config.test.ts` covers present config, missing ADO config, optional `ADO_WEBHOOK_SECRET`, and PAT redaction.
- Config errors are structured so local-only startup can continue while ADO operations remain blocked.

**Out of scope here:**
- ADO connectivity checks and token scope validation.

**Verify:**
```bash
bun test tests/server/config.test.ts
```
Expected: Config tests pass and serialized config never contains the PAT.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 1.4 — Add SQLite Migrations

**Goal:** The app can create and version the MVP metadata database.

**Deliverables:**
- `src/server/db.ts` opens `ADO_WORKSPACE_DIR/.surfboard/surfboard.db` using `bun:sqlite`.
- `src/server/migrations.ts` applies schema version `1` for spec §10 tables, indexes, and schema version tracking.
- `tests/server/db.test.ts` verifies idempotent migrations and `ado_id` uniqueness when present.

**Out of scope here:**
- Cache update helpers, audit helpers, and workspace scanning.

**Verify:**
```bash
bun test tests/server/db.test.ts
```
Expected: Migration tests pass against an isolated temp workspace.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 1.5 — Build Fastify App And Health Route

**Goal:** The backend serves a health endpoint with app, config, and SQLite status.

**Deliverables:**
- `src/server/app.ts` creates the Fastify app and registers route modules.
- `src/server/health.ts` reports app version, config, SQLite, workspace, and template status for spec §15.
- `src/server/index.ts` starts the server on `127.0.0.1:3000` by default.
- `tests/server/health.test.ts` verifies healthy and degraded config responses.

**Out of scope here:**
- ADO auth checks, file watcher health, and sync summaries.

**Verify:**
```bash
bun test tests/server/health.test.ts
```
Expected: Health route returns structured status for healthy and degraded fixtures.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 1.6 — Serve Static Frontend Shell

**Goal:** The browser can load the minimal Surfboard layout shell.

**Deliverables:**
- `src/frontend/index.html`, `src/frontend/app.ts`, and `src/frontend/styles.css` render the parent header, child grid, global actions, row actions, and footer placeholders from spec §8.
- `scripts/build-frontend.ts` uses `Bun.build` to bundle frontend assets.
- `src/server/static.ts` serves bundled frontend assets from `dist/frontend`.

**Out of scope here:**
- Real data loading, hotkeys, modals, and row action behavior.

**Verify:**
```bash
bun run build
```
Expected: Backend and frontend build artifacts are produced without errors.

**Done when:** Verify command passes and `bun run check` is clean.

## Task 1.7 — Create Fixture And Workspace Conventions

**Goal:** Safe fixture and development workspace paths exist for later phases.

**Deliverables:**
- `workspace/.gitkeep`, `workspace/templates/.gitkeep`, and `workspace/workitems/.gitkeep` establish default local workspace folders.
- `tests/fixtures/README.md` documents fixture categories and refresh rules.
- `tests/fixtures/workspace-empty/` contains an empty workspace fixture for config and migration tests.

**Out of scope here:**
- Real YAML templates, work item documents, and recorded ADO responses.

**Verify:**
```bash
bun test tests/fixtures/fixtures.test.ts
```
Expected: Fixture tests confirm expected directories exist and contain no unsafe ADO mutation targets.

**Done when:** Verify command passes and `bun run typecheck` is clean.

## Task 1.8 — Add Phase Verification Script

**Goal:** Phase 1 has a single command that proves the runnable bootstrap state.

**Deliverables:**
- `scripts/smoke-health.ts` verifies `/api/health` against a test server or started app.
- `package.json` wires `verify:phase1` to typecheck, tests, build, and health smoke.
- Placeholder scripts for later phase verification fail with a clear “not implemented yet” message.

**Out of scope here:**
- Later phase verification logic.

**Verify:**
```bash
bun run verify:phase1
```
Expected: Typecheck, tests, build, migration, and health smoke all pass.

**Done when:** Verify command passes and the task is committed on `main`.

## Phase verification

```bash
bun run verify:phase1
```
Expected: The bootstrapped app builds, tests, migrates SQLite, serves health, and has a static frontend shell.

