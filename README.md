# Surfboard

Local YAML-based Azure DevOps Boards client. YAML is authoritative for local intended state; SQLite tracks ADO revision metadata; all writes are user-triggered, prevalidated, revision-checked, sequentially pushed, and audited.

See `docs/2026-05-06-initial-spec.md` for the full specification and `CLAUDE.md` for the safety contract.

## Setup

Requires Bun 1.3.13.

```bash
bun install
```

## Environment

Surfboard reads ADO config from `process.env`. Nothing is persisted to disk.

| Variable | Required for | Notes |
|---|---|---|
| `ADO_ORG` | ADO routes | Must be `goalliant` for the live smokes. |
| `ADO_PROJECT` | ADO routes | Must be `Alliant` for the live smokes. |
| `ADO_PAT` | ADO routes | Personal access token; never logged or persisted. |
| `ADO_API_VERSION` | optional | Defaults to `7.1`. |
| `ADO_WORKSPACE_DIR` | always | Local workspace root. The SQLite cache lives at `<dir>/.surfboard/surfboard.db`. |
| `ADO_TEMPLATE_DIR` | always | Where local YAML templates live. |
| `ADO_WEBHOOK_SECRET` | optional | When set, `/api/webhooks/ado` requires this header value. |

If ADO env vars are missing, the server still starts and local validation/refresh routes work; ADO pull/push routes are unavailable.

## Common commands

```bash
bun run dev               # boot server on http://127.0.0.1:3000
bun run build             # bundle frontend to dist/frontend
bun run typecheck         # tsc --noEmit
bun test                  # run all tests
bun run check             # typecheck + tests
bun run verify:phase1     # phase 1 verification
bun run verify:phase2     # phase 1 + local validation smoke
bun run verify:phase3     # phase 2 + ADO read smoke (live, opt-in via env)
bun run verify:phase4     # phase 3 + ADO write smoke (gated; see below)
bun run verify:phase5     # phase 4 + MVP smoke
bun run verify:mvp        # final: typecheck + tests + build + MVP smoke
```

## Live ADO smoke commands

These are the only scripts that talk to real ADO. They refuse to run unless the env matches `docs/plan/00-decisions.md`.

```bash
# Read-only (safe). Reports parent 221835 + direct children + project metadata.
ADO_ORG=goalliant ADO_PROJECT=Alliant bun run smoke:ado-read

# Write smoke (gated). Creates ONE child PBI under safe parent 221835 and
# updates it once. Never deletes. Requires explicit opt-in.
SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes \
  ADO_ORG=goalliant ADO_PROJECT=Alliant \
  bun run smoke:ado-write
```

## Safety guarantees

These are load-bearing — see `CLAUDE.md` and the spec for context.

- YAML is authoritative for local content. SQLite stores only metadata.
- ADO `System.Rev` is authoritative for remote state. Every update JSON Patch begins with `{op: "test", path: "/rev", value: <cachedRev>}`.
- No automatic syncing, no background push, no automatic write retry.
- Pull never silently overwrites local YAML when remote diverged. Confirmation popup required (default action: cancel).
- Stop-on-first-failure for batch pushes. No atomic rollback.
- No force ops in MVP: no force push, no auto-rollback, no YAML deletion, no ADO work item deletion, no work-item-type changes.
- Live write smoke refuses to run unless `SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes` and the org/project/parent match the safe configuration.

## Pause-for-input triggers

Per `docs/plan/00-decisions.md`, pause and ask before:

- Any irreversible action against the real ADO project.
- Any mutation outside work item `221835` or app-created children under it.
- A test failure unresolved within two attempts.
- Adding a dependency not pre-approved in `docs/plan/00-decisions.md`.
- Pushing to `origin`.

## Layout

```
src/
  server/      adoClient, adoMapper, adoMetadata, app, audit, config,
               db, fileWatcher, hash, health, migrations, patchBuilder,
               routes, static, syncEngine, templateStore, validator,
               webhookServer, workspace, workspaceState, index
  frontend/    index.html, app.ts, render.ts, styles.css
  shared/      types.ts, constants.ts
scripts/       build, smoke-*, verify-*
tests/
  fixtures/    yaml, templates, ado, acceptance
  server/      unit and route tests
  frontend/    pure render + hotkey tests
  acceptance/  spec §19 acceptance suite
docs/
  2026-05-06-initial-spec.md   # source of truth
  plan/                         # phase plans + decisions
```
