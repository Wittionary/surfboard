# 2026-06-11 Containerize

Surfboard should run as a container by default for local use, so a fresh machine can launch the app with `docker compose up` and nothing else installed beyond Docker. Non-container `bun run dev` stays supported for active development against the source tree.

The container packages the Bun runtime, the built static frontend, and the server. The user's workspace (YAML + the per-workspace SQLite cache at `<workspace>/.surfboard/surfboard.db`) is a bind-mounted host directory so YAML files stay editable in the user's normal editor and the cache persists across container restarts. ADO credentials and other env are injected through the env file the user already maintains for local runs.

## Decisions

- Base image: `oven/bun:1.3.13-slim` (Debian-based). Pinned to the same Bun version the README requires; slim avoids musl edge cases with `bun:sqlite` and `chokidar`.
- Multi-stage `Dockerfile`: `deps` (install with frozen lockfile) → `build` (run `bun run build` to produce `dist/`) → `runtime` (only production deps + built artifacts + `src/`).
- The runtime image runs `bun run src/server/index.ts` as its entrypoint. No transpile step for server code; Bun loads TS at runtime, consistent with `bun run dev`.
- `docker-compose.yml` is the de facto launcher. It mounts `./workspace` to `/workspace`, reads `.env`, and publishes `${SURFBOARD_PORT:-3000}`.
- The server binds `0.0.0.0` inside the container (`SURFBOARD_HOST=0.0.0.0`). The host-side default still listens on localhost via Docker's port publish, so the app is not exposed to the LAN unless the user changes the publish address.
- The container runs as a non-root user. UID/GID are configurable via build args so bind-mounted YAML files stay writable by the host user.
- `chokidar` polling stays on by default (preserving today's `FileWatcher` behavior — no regression for existing host dev). `SURFBOARD_WATCH_POLLING=0` (or `false`/`off`) is the opt-out switch that turns on native filesystem events; useful for `bun run dev` on macOS/Linux where fsevents/inotify are reliable. The container ships with `SURFBOARD_WATCH_POLLING=1` set explicitly for documentation, even though it has no functional effect over the default.
- ADO PAT and other secrets are passed through `.env` / `env_file:` only. Never baked into the image, never committed. A `.env.example` documents the variables.
- Image is built locally; no registry push, no CI publish step in MVP scope.
- Container image is intentionally read-only for `/app`. Only `/workspace` (bind mount) and `/tmp` are writable. Implemented as `read_only: true` + `tmpfs: [/tmp]` in `docker-compose.yml`, and mirrored in `verify-container.ts` so the guarantee is checked rather than assumed. Bind mounts are unaffected by `read_only`, so host-side YAML authoring is untouched.
- Compose profile `dev` is **out of scope**. Local dev keeps using `bun run dev` directly against the host. Mixing both is not supported.
- **Podman is a supported runtime**, not just Docker (revised 2026-08-18 — see Verification results). `verify-container.ts` resolves a real binary via `SURFBOARD_CONTAINER_CLI`, else probes `podman` then `docker`; it cannot rely on a `docker`→`podman` shell alias, because aliases do not apply to spawned processes.

## Phase 1 - Baseline Dockerfile

**Goal:** A reproducible image that boots Surfboard and serves `/api/health` with the bundled static frontend.

**Implementation notes:**

- Add `Dockerfile` at repo root with three stages: `deps`, `build`, `runtime`.
- `deps` stage: copy `package.json` and `bun.lock`, run `bun install --frozen-lockfile`.
- `build` stage: copy source, run `bun run build` to produce `dist/`.
- `runtime` stage: copy `node_modules`, `src/`, `dist/`, `package.json`, `tsconfig.json`. Set `WORKDIR=/app`.
- Create a non-root user `surfboard` (uid 1000 by default, overridable via `--build-arg UID=…`/`GID=…`).
- `ENV SURFBOARD_HOST=0.0.0.0`, `ENV SURFBOARD_PORT=3000`, `ENV NODE_ENV=production`, `ENV ADO_WORKSPACE_DIR=/workspace`, `ENV ADO_TEMPLATE_DIR=/workspace/templates`.
- Default command: `["bun", "run", "src/server/index.ts"]`.
- Add `.dockerignore` covering `node_modules`, `dist`, `.git`, `workspace`, `tests`, `docs`, `*.md` except `README.md`, and any local `.env*` files.

**Acceptance criteria:**

- `docker build -t surfboard:dev .` succeeds on a clean clone.
- `docker run --rm -e ADO_WORKSPACE_DIR=/tmp/ws -e ADO_TEMPLATE_DIR=/tmp/ws -v /tmp/ws:/tmp/ws -p 3000:3000 surfboard:dev` starts the server and `curl http://localhost:3000/api/health` returns `200` with `sqlite.status === "ok"`.
- The image does not contain `.git`, `tests/`, or any `.env*` file.
- The running container's process is not root.

**Verify:**

```bash
docker build -t surfboard:dev .
docker run --rm -d --name surfboard-smoke \
  -e ADO_WORKSPACE_DIR=/workspace -e ADO_TEMPLATE_DIR=/workspace/templates \
  -v "$(pwd)/workspace:/workspace" -p 3000:3000 surfboard:dev
curl -fsS http://localhost:3000/api/health | grep '"status":"ok"'
docker stop surfboard-smoke
```

## Phase 2 - docker-compose.yml and env wiring

**Goal:** `docker compose up` is the documented first command for a new user and produces a healthy, browser-reachable app pointing at their `./workspace`.

**Implementation notes:**

- Add `docker-compose.yml` at repo root with one service, `surfboard`.
- `build: .`, `image: surfboard:local`, `env_file: .env`, `ports: ["${SURFBOARD_PORT:-3000}:3000"]`.
- Mount `./workspace:/workspace` (the canonical bind). Templates default to `/workspace/templates`, which already exists in the repo workspace.
- `user: "${HOST_UID:-1000}:${HOST_GID:-1000}"` so writes to the bind mount keep the host user as owner.
- `restart: unless-stopped` so a user closing the laptop and reopening keeps the app reachable; aligns with "de facto standard".
- Add `.env.example` listing every variable the README enumerates plus `HOST_UID`, `HOST_GID`, `SURFBOARD_WATCH_POLLING`, and a placeholder `ADO_PAT=`.
- Add `.env` to `.gitignore` if it is not already.
- Do not declare a named volume for SQLite — the database lives inside the bind-mounted `./workspace/.surfboard/` directory so the cache is colocated with the YAML it indexes and travels with the workspace.

**Acceptance criteria:**

- A fresh checkout with `cp .env.example .env` (filled in) and `docker compose up` boots the app and the user can load `http://localhost:3000/`.
- The SQLite file appears at `./workspace/.surfboard/surfboard.db` on the host after first request.
- Editing a YAML file in `./workspace/` from the host editor is visible to subsequent `POST /api/workspace/refresh` calls inside the container.
- Stopping with Ctrl-C cleanly shuts the container down (Fastify close, no orphan process).
- `git status` is clean after a full up/down cycle (no committed cache, no committed `.env`).

**Verify:**

```bash
cp .env.example .env  # fill in ADO_* values
docker compose up -d
curl -fsS http://localhost:3000/api/health
docker compose down
test -f workspace/.surfboard/surfboard.db
```

## Phase 3 - File watching across the bind mount

**Goal:** Workspace edits made on the host are detected by `chokidar` inside the container reliably on macOS, Windows, and Linux hosts.

**Implementation notes:**

- Read `SURFBOARD_WATCH_POLLING` in `src/server/app.ts` and pass `{ usePolling: false }` to the `FileWatcher` when the value is `"0"`/`"false"`/`"off"`. Any other value (including unset) leaves the `FileWatcher` default of polling on intact.
- Set `SURFBOARD_WATCH_POLLING=1` in the `Dockerfile` runtime stage for explicit documentation; functionally a no-op over the default.
- Document the env var in the README env table.
- Polling interval is not user-tunable in MVP; if a user reports CPU cost, surface that as a future task rather than expanding scope now.

**Acceptance criteria:**

- Inside the container, creating `workspace/foo.yaml` on the host causes the watcher to fire within ~1 second on macOS.
- Local `bun run dev` (no env var) continues to poll, matching today's behavior — no regression. Users who want fsevents/inotify on the host can set `SURFBOARD_WATCH_POLLING=0`.
- Watcher health (`report.watcher.status` in `/api/health`) is `ok` inside the container.

**Verify:**

```bash
docker compose up -d
touch workspace/_watch-probe.yaml
# observe watcher trigger in `docker compose logs -f surfboard`
rm workspace/_watch-probe.yaml
docker compose down
```

## Phase 4 - Healthcheck, signals, and shutdown

**Goal:** The container reports health accurately to Docker and exits cleanly on `SIGTERM` so `docker compose down` is fast and does not corrupt SQLite.

**Implementation notes:**

- Add `HEALTHCHECK` to the `Dockerfile`: `CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1`, `interval=30s`, `timeout=3s`, `start-period=10s`, `retries=3`. Use `wget` (present in `oven/bun:slim`) instead of pulling in `curl`.
- Confirm `src/server/index.ts` handles `SIGTERM` by calling `fastify.close()` and closing the SQLite handle. If it does not today, add the handler — Bun forwards POSIX signals to the foreground process when PID 1 is the Bun executable.
- Use `init: true` in `docker-compose.yml` so Docker provides a tini-equivalent reaping init and signal forwarding works regardless of host platform.
- Keep all logs on stdout/stderr (Pino already writes there). No log files inside the container.

**Acceptance criteria:**

- `docker inspect --format '{{.State.Health.Status}}' surfboard` reports `healthy` within 60 s of startup.
- `docker compose down` returns in under 5 s with exit code 0; no `SIGKILL` warning.
- After a forced kill (`docker kill -s KILL`), the next `docker compose up` still opens the SQLite cache cleanly (validates the WAL is intact and we are not relying on graceful close for correctness).

**Verify:**

```bash
docker compose up -d
sleep 15
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q surfboard)
time docker compose down
docker compose up -d && docker kill -s KILL $(docker compose ps -q surfboard) && docker compose up -d
curl -fsS http://localhost:3000/api/health
docker compose down
```

## Phase 5 - README and developer ergonomics

**Goal:** The README presents the container path first, the local-dev path second, and the file watching / UID quirks are documented where users will hit them.

**Implementation notes:**

- Restructure `README.md` "Setup" so the first section is "Run with Docker" (one `cp .env.example .env` + `docker compose up`).
- A second section, "Local development", retains the existing Bun-based instructions verbatim.
- Update the env table to add `SURFBOARD_HOST`, `SURFBOARD_PORT`, `SURFBOARD_WATCH_POLLING`, `HOST_UID`, `HOST_GID`.
- Note that `workspace/.surfboard/surfboard.db` is the cache file and that deleting it forces a full re-index on next refresh.
- Note that ADO write smokes (`SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes`) still run on the host with `bun`, not in the container — the container is for the app, not for the developer's verification scripts.
- Do not introduce a Makefile. `docker compose up` / `down` is short enough and adding a Make layer creates two ways to do the same thing.

**Acceptance criteria:**

- Following the README "Run with Docker" section on a machine with only Docker installed brings the app up and visible at `http://localhost:3000/`.
- The "Local development" section still describes `bun install` + `bun run dev` accurately.
- The env table lists every variable the runtime reads.

**Verify:**

Manual: hand the README to a teammate who has never seen the repo, observe whether they reach a working UI without help.

## Phase 6 - Container verification script

**Goal:** A scripted check that the container path actually works, runnable from CI or locally, so this does not silently rot.

**Implementation notes:**

- Add `scripts/verify-container.ts` that:
  1. Builds the image (`docker build -t surfboard:verify .`).
  2. Starts a container with a temp workspace bind-mounted in, no ADO env (so ADO routes stay unavailable, which is the spec-correct behavior).
  3. Polls `/api/health` until status is `ok` or a 30 s timeout elapses.
  4. Asserts `report.sqlite.status === "ok"` and `report.watcher.status === "ok"`.
  5. Tears down the container and removes the temp workspace.
- Add `"verify:container": "bun run scripts/verify-container.ts"` to `package.json`.
- Do not wire it into `verify:mvp` — the container build is too slow for the inner loop; it is its own opt-in check.

**Acceptance criteria:**

- `bun run verify:container` exits 0 on a clean checkout with Docker available.
- The script removes its temp workspace and stops the container even when the inner check fails.
- The script never logs the ADO PAT (defensive, even though it should not be present in this flow).

**Verify:**

```bash
bun run verify:container
```

## Out of scope

- Publishing an image to a registry (Docker Hub, GHCR, internal). Local build only.
- A `dev` compose profile that mounts source for live reload inside the container. Local dev keeps using `bun run dev` on the host.
- Multi-arch builds. The default `docker build` on the user's machine produces the right arch for that machine.
- Windows-specific path quirks beyond what bind mounts already paper over.
- Reverse proxy / TLS / auth. Surfboard is a single-user local tool; exposing it beyond localhost is out of scope.
- CI execution of `verify:container`. The repo has no workflows (`.github/` holds skills only); the script is CI-ready but nothing is wired.

## Verification results (2026-08-18)

Executed on macOS with **rootless Podman 5.8.5** (compose via the external `docker-compose` v5.1.3 provider). Every phase passed; the items below are the ones that were not merely re-read but actually exercised.

| Phase | Criterion | Result |
|---|---|---|
| 1 | Image builds; no `.git` / `tests/` / `.env*` inside; non-root | Pass — `/app` holds only `bun.lock dist node_modules package.json scripts src tsconfig.json`; image 284 MB |
| 2 | Compose boots, workspace + SQLite resolve to the bind mount | Pass — `workspace.path=/workspace`, cache at `workspace/.surfboard/surfboard.db` owned by the host user; `git status` clean after up/down |
| 3 | Host edit detected inside the container | Pass — host create, edit, and delete each produced one `workspace refreshed` |
| 4 | `compose down` under 5 s, exit 0, no SIGKILL | Pass — 0.45–0.54 s |
| 4 | `SIGKILL` then restart reopens SQLite cleanly | Pass — `app=ok sqlite=ok watcher=ok workspace=ok` |
| 6 | `bun run verify:container` exits 0 | Pass |
| — | `read_only: true`: `/app` immutable, `/tmp` writable, host authoring unaffected | Pass |

### Defects found and fixed during verification

1. **The image had never built.** The runtime stage's `useradd --uid 1000` always failed — the base image's `bun` user already owns uid/gid 1000. Now renames the incumbent on collision.
2. **`env_file` silently overrode image `ENV`.** A `SURFBOARD_PORT` in `.env` moved the listener off the published target, and `ADO_WORKSPACE_DIR=./workspace` made the container index `/app/workspace` instead of the bind mount — wrong data, no error. `SURFBOARD_PORT`, `ADO_WORKSPACE_DIR`, and `ADO_TEMPLATE_DIR` are now pinned in compose's `environment:`, which takes precedence. `SURFBOARD_PORT` in `.env` selects the host port only.
3. **The file watcher never ran in production.** `startWatcher` was passed only by tests, so `src/server/index.ts` built the app without one — on `main` too, making Phase 3 dead code and contradicting spec §120/§888. Now `startWatcher: true`.
4. **`verify-container.ts` skipped the watcher assertion when absent** (`if (report.watcher && …)`), which is what let #3 go unnoticed. Now asserts presence.
5. **`.env.example` was never updated** with `HOST_UID` / `HOST_GID` / `SURFBOARD_PORT`, despite the README instructing users to set them.

### Environment note

The Podman machine's clock can drift behind the host after laptop sleep (observed: 5 days). `podman logs --since <host timestamp>` then returns nothing and reads as "the watcher never fired." Use event-count deltas, or `podman machine stop && podman machine start`.
