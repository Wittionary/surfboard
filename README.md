# Surfboard

Local YAML-based Azure DevOps Boards client. YAML is authoritative for local intended state; SQLite tracks ADO revision metadata; all writes are user-triggered, prevalidated, revision-checked, sequentially pushed, and audited.

See `docs/2026-05-06-initial-spec.md` for the full specification and `CLAUDE.md` for the safety contract.

## Run in a container (default)

A container is the supported way to run Surfboard locally. You only need Docker or Podman; you do not need Bun on the host.

```bash
cp .env.example .env        # then fill in ADO_ORG, ADO_PROJECT, ADO_PAT
docker compose up           # build + start; published on 127.0.0.1:3000
```

Podman works equivalently — use `podman-compose up`, or rely on a `docker`→`podman` alias. The `verify:container` script reads `SURFBOARD_CONTAINER_CLI` if set (e.g. `SURFBOARD_CONTAINER_CLI=podman bun run verify:container`), and otherwise probes `podman` then `docker`.

Open `http://localhost:3000/`. Stop with Ctrl-C or `docker compose down` / `podman-compose down`.

Your workspace lives on the host at `./workspace` and is bind-mounted into the container. The SQLite cache lives next to your YAML at `./workspace/.surfboard/surfboard.db`, so it survives container rebuilds and stays paired with the YAML it indexes.

Match `HOST_UID` / `HOST_GID` in `.env` to your host user (`id -u`, `id -g`) so files written by the container stay editable by your normal editor. Under rootless Podman the host user already owns bind-mount writes by default, but setting the vars keeps Docker hosts working without extra steps.

## Local development

Use this when you are editing Surfboard's own source. Requires Bun 1.3.13.

```bash
bun install
bun run dev                 # boot server on http://127.0.0.1:3000
```

The host-side path uses native filesystem events; you do not need `SURFBOARD_WATCH_POLLING`.

## Environment

Surfboard reads ADO config from `process.env`. Nothing is persisted to disk. With Docker, set these in `.env` (read by `docker-compose.yml`'s `env_file`).

| Variable | Required for | Notes |
|---|---|---|
| `ADO_ORG` | ADO routes | Must be `goalliant` for the live smokes. |
| `ADO_PROJECT` | ADO routes | Must be `Alliant` for the live smokes. |
| `ADO_PAT` | ADO routes | Personal access token; never logged or persisted. |
| `ADO_API_VERSION` | optional | Defaults to `7.1`. |
| `ADO_WORKSPACE_DIR` | always | Local workspace root. The SQLite cache lives at `<dir>/.surfboard/surfboard.db`. Defaults to `/workspace` in the container. |
| `ADO_TEMPLATE_DIR` | always | Where local YAML templates live. Defaults to `/workspace/templates` in the container. |
| `ADO_WEBHOOK_SECRET` | optional | When set, `/api/webhooks/ado` requires this header value. |
| `SURFBOARD_HOST` | optional | Bind address. Defaults to `127.0.0.1` for local dev; the container sets `0.0.0.0`. |
| `SURFBOARD_PORT` | optional | Listen port. Defaults to `3000`. Under Compose this selects the **host** port; the container always listens on `3000`. |
| `SURFBOARD_WATCH_POLLING` | optional | `0`/`false`/`off` forces native filesystem events. Any other value (default) polls — the container ships with polling on because bind mounts on Docker Desktop do not emit reliable native events. |
| `HOST_UID` / `HOST_GID` | optional | Docker only. Match your host user so bind-mounted YAML stays writable. Defaults to `1000`. |

If ADO env vars are missing, the server still starts and local validation/refresh routes work; ADO pull/push routes are unavailable.

Deleting `./workspace/.surfboard/surfboard.db` is safe — Surfboard rebuilds the cache on the next refresh.

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
bun run verify:container  # build image + boot container + assert /api/health
```

The `verify:container` step is not included in `verify:mvp` because building the image is slow; run it explicitly when changing anything under `Dockerfile`, `docker-compose.yml`, or `scripts/healthcheck.ts`.

Live ADO write smokes (`SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes`) run on the host with Bun, not inside the container. The container is the app; the smokes are developer scripts.

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
