# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Greenfield. No code, no `package.json`, no build tooling yet — only the specification at `docs/2026-05-06-initial-spec.md`. That document is the source of truth for what to build; read it before making non-trivial decisions. Commands (build/lint/test) will appear here as the toolchain is established.

## What this app is

Surfboard is a locally hosted TypeScript web app that lets a single user manage Azure DevOps Boards work items (Epic / Feature / PBI / Enabler / Task) faster than the native ADO UI by using local YAML files as the primary authoring surface. It is **not** a full ADO Boards replacement — it is a YAML-driven staging and sync client for one ADO project.

## Authority model — get this right or the app is broken

These two invariants drive almost every design decision; any change that weakens them needs explicit user approval:

1. **YAML files are authoritative for local intended state.** SQLite is *never* authoritative for work item content — it stores only ADO ID mapping, last-known revision, sync status, hashes, and audit. If a piece of work item content lives only in SQLite, that's a bug.
2. **ADO `System.Rev` is authoritative for remote state.** Before any push, fetch the latest remote revision and block the push if it differs from the cached `last_known_rev`. Every update JSON Patch must include a `test` op against `/rev`.

## Safety rules that must never silently degrade

- **No automatic syncing, no background push, no automatic write retry.** All writes are user-triggered.
- **Block over guess.** Hard blockers (missing required fields, invalid schema, missing/invalid parent, duplicate `metadata.localId`, duplicate sibling titles, remote revision drift, remote deletion, unknown YAML fields) must fail validation and stop the operation — never patch around them.
- **Pull never silently overwrites existing local YAML** when the remote item changed since the last accepted baseline. It must require an explicit popup confirmation; default action is cancel. If declined, leave YAML and the `last_known_*` baseline untouched and update only `last_remote_rev` / `remote_changed_at` / `remote_checked_at`.
- **Stop-on-first-failure** for batch pushes. Push sequentially in dependency order (parent update first, then children). "Transaction-like" here means prevalidate-everything + sequential + stop-on-first-failure + audit — *not* atomic rollback.
- **Force operations are out of scope for MVP.** No force push, no auto-rollback, no deleting YAML files, no deleting ADO work items, no work-item-type changes. Parent reparenting requires explicit confirmation and still passes all normal checks.

## Architecture at a glance

Planned layout (per spec §9.2):

```
src/
  server/      adoClient, syncEngine, validator, yamlStore, fileWatcher,
               db, audit, webhookServer, health, routes
  frontend/    index.html, app.ts, styles.css   (minimal; Vite or static TS)
  shared/      types.ts, constants.ts
```

Recommended runtime: Node.js + Fastify (or native HTTP) + SQLite + minimal frontend. Keep dependencies minimal; prefer a custom thin ADO REST wrapper over a large SDK.

**YAML envelope** is Kubernetes-style: `apiVersion` / `kind` / `metadata` / `spec`. `kind` is the ADO work item type. `spec.fields` keys are ADO field reference names (e.g. `System.Title`, `Microsoft.VSTS.Common.Priority`). `spec.tags` serializes to ADO's semicolon-delimited `System.Tags`. Multi-document YAML (`---` separators) is in scope: identity is `(yaml_path, yaml_document_index)`, and `metadata.localId` must be unique workspace-wide.

**Parent rules:** Epic→none, Feature→Epic, PBI→Feature, Enabler→Feature, Task→PBI or Enabler. A child cannot be pushed if its required parent has no ADO ID. Parent creation is **out of scope for MVP** — the selected parent must already exist in ADO.

**Conflict detection** is pre-push revision check, full stop. Webhooks are advisory status only (default mode is disabled — a purely local app generally cannot receive ADO webhooks without a tunnel). Never rely on webhooks for correctness.

**Hashing:** field/relation hashes must be computed from canonically normalized data so YAML formatting/comments don't produce false content changes.

**Auditing:** every pull/push attempt writes an `audit_log` row (success or failure). Redact PATs and authorization headers from request/response summaries.

## Configuration

All ADO config comes from environment variables — never persisted to disk:

```
ADO_ORG, ADO_PROJECT, ADO_PAT, ADO_API_VERSION (=7.1),
ADO_WEBHOOK_SECRET, ADO_WORKSPACE_DIR, ADO_TEMPLATE_DIR
```

## When in doubt

- Cross-check against `docs/2026-05-06-initial-spec.md` — section numbers align with the topic (e.g. §7 validation, §10 SQLite schema, §11 ADO integration, §13 sync engine, §17 local API endpoints, §18 TS domain types).
- The spec deliberately calls out scope boundaries in §3, blind spots in §21, and required acceptance flows in §19. Before adding a feature that feels load-bearing, check whether the spec already places it in/out of MVP scope.
