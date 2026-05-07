# Surfboard Implementation Decisions

## Hard invariants

- YAML files are authoritative for local intended state. SQLite stores only metadata, never work item content.
- ADO `System.Rev` is authoritative for remote state. Every update JSON Patch includes a `test` op against `/rev`.
- No automatic syncing, no background push, no automatic write retry.
- Hard blockers stop operations — never patch around them.
- Pull never silently overwrites existing local YAML when the remote item changed. Confirmation popup required; default action is cancel.
- Stop-on-first-failure for batch pushes. No atomic rollback is promised.
- No force ops in MVP: no force push, no auto-rollback, no YAML deletion, no ADO work item deletion, no work-item-type changes.

## Technology choices

- Runtime: Bun `1.3.13`; selected because the user prefers Bun and it provides runtime, package manager, bundler, and test runner in one maintained tool.
- HTTP server library: Fastify `5.8.5`; selected because it matches spec §9.1, is maintained, and keeps the server lightweight.
- TypeScript run/build tool: Bun `1.3.13` plus TypeScript `5.9.2`; Bun runs TypeScript files and `tsc --noEmit` provides strict typechecking.
- Test runner: Bun test from Bun `1.3.13`; selected to avoid a second test stack.
- Linter / formatter: none for MVP; strict TypeScript and focused tests are the required checks.
- YAML parser: `yaml@2.8.3`; selected because it supports multi-document parsing required by spec §5.2.
- Schema validator: `ajv@8.20.0`; selected for local JSON-schema-style validation of template-derived rules.
- SQLite driver: `bun:sqlite` from Bun `1.3.13`; selected to avoid native addon setup.
- File watcher: `chokidar@5.0.0`; selected for recursive cross-platform watching required by spec §3 and §9.3.
- Frontend bundler / approach: static vanilla TypeScript bundled with `Bun.build`; selected to keep the frontend minimal per spec §8 and §9.1.
- Logger: `pino@10.3.1`; selected for structured logs and redaction support.
- Bun type definitions: `@types/bun@1.3.10`; selected for strict TypeScript coverage of Bun APIs.
- Package manager: Bun `1.3.13`; selected to match runtime and generate `bun.lock`.
- Single-command dev server invocation: `bun run dev`; starts the local server and serves bundled frontend assets.

## Runtime configuration

- `src/server/config.ts` loads config only from `process.env` and validates the contract from spec §11.1.
- Required development values are `ADO_ORG=goalliant`, `ADO_PROJECT=Alliant`, `ADO_API_VERSION=7.1`, `ADO_WORKSPACE_DIR=/mnt/c/Users/jallen4/git/surfboard/workspace`, and `ADO_TEMPLATE_DIR=/mnt/c/Users/jallen4/git/surfboard/workspace/templates`.
- `$ADO_PAT` is assumed to exist in the shell and must never be persisted or logged.
- `ADO_WEBHOOK_SECRET` is optional because MVP webhook mode is disabled by default per spec §12.
- Missing ADO config must not prevent local validation startup; it must make ADO health failed and block ADO pull/push routes.

## Test ADO boundaries

- The safe mutable parent work item is `221835`.
- The agent may create child work items under `221835` during write-smoke tasks.
- The agent must not mutate any pre-existing work item other than `221835`.
- Any live ADO write smoke must require an explicit env flag and must refuse to run outside the configured org/project/parent.

## Commit and dependency rules

- Commit after every completed task on `main`.
- Do not push to `origin` autonomously.
- Do not add dependencies outside this file without pausing for human input.
- Do not modify `docs/2026-05-06-initial-spec.md` or `CLAUDE.md` while implementing this plan.

## Cross-cutting ownership

- Environment variable contract: Phase 1 loads and validates it; Phase 3 adds ADO-specific health checks.
- Fixture strategy: Phase 1 creates fixture conventions; Phases 2 through 5 add local YAML, ADO response, push, conflict, webhook, and acceptance fixtures.
- ADO metadata discovery: Phase 3 implements startup/refresh discovery and caches results in SQLite `settings`.
- SQLite migrations / schema versioning: Phase 1 implements schema versioning and MVP tables.
- Audit log redaction: Phase 3 starts pull audit records; Phase 4 completes redacted write summaries.
- Hash canonicalization rules: Phase 2 implements canonical field/relation hashes per spec §7.
- Multi-document YAML identity: Phase 2 enforces `yaml_path` plus `yaml_document_index` and workspace-wide `metadata.localId`.

## Pause-for-input triggers

- Any irreversible action against the real ADO project.
- Any mutation outside work item `221835` or app-created children under it.
- Spec ambiguity that a reasonable engineer would interpret two different ways.
- A test failure the agent cannot resolve within two attempts.
- Any request to add a dependency not pre-approved in this file.
- Any command that would push to `origin`.

