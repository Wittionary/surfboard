# Surfboard Implementation Plan — Planner Prompt

You are an implementation planner. Your job is to translate the specification at `docs/2026-05-06-initial-spec.md` into a concrete, ordered, autonomously-executable plan for Claude Code (a coding agent) to follow. The user wants to be hands-off: every ambiguity you leave in the plan is a place the agent will stall or guess.

Read the spec in full before producing output. Treat it as the source of truth. Treat `CLAUDE.md` at the repo root as the safety contract — its invariants must not be relaxed anywhere in your plan.

---

## Output

Write multiple Markdown files under `docs/plan/`, not one mega-doc:

```
docs/plan/
  00-decisions.md          # all upfront tech choices, pinned with versions
  01-phase-bootstrap.md    # toolchain + project skeleton
  02-phase-yaml-validate.md
  03-phase-ado-pull.md
  04-phase-push-engine.md
  05-phase-conflict-webhook.md
  fixtures/                # any test YAML, ADO IDs, recorded responses
```

Phase boundaries should roughly follow spec §20 ("Recommended MVP Build Order") but you must split each phase into 6–12 finer-grained tasks. Re-number phases if you have a better partition; just keep them ordered and each one ending in a runnable, verifiable app state.

Do **not** include code samples beyond one-line snippets. The spec already supplies type shapes and SQL schemas. Link to spec sections by number (`§7.2`) rather than re-deriving content.

Keep prose lean. One-sentence rationale per task is plenty.

---

## `00-decisions.md` — lock these before phase 1

Pin every open technology choice with an exact version. Default to picking yourself. Only defer to the agent if you have no basis for a choice; in that case write `Agent picks` explicitly so it's clear the decision is delegated, not forgotten. Required entries:

- Runtime (Node vs Bun, exact version)
- HTTP server library
- TypeScript run/build tool
- Test runner
- Linter / formatter (or none)
- YAML parser (must support multi-document)
- Schema validator
- SQLite driver
- File watcher
- Frontend bundler / approach
- Logger
- Package manager
- Single-command dev server invocation

For each decision, one sentence of rationale is enough.

---

## Per-task contract

Every task in every phase file must have exactly these four fields, in this order:

```markdown
## Task <phase>.<n> — <short title>

**Goal:** One sentence stating the externally observable outcome.

**Deliverables:**
- File-level bullets. Name the files, exports, and behaviors.
- Reference spec sections where relevant (e.g. "implements §7 validation rules for unknown top-level keys").

**Out of scope here:**
- What this task must NOT touch. Helps prevent scope drift.

**Verify:**
```bash
<single shell command the agent can run to confirm success>
```
Expected: <one-line description of pass criteria>.

**Done when:** <terminal condition — usually "verify command passes and `<typecheck command>` is clean">.
```

If a task cannot state a one-line `Verify` command, it is too vague — split or rewrite it. Tasks must be sized 30 minutes to 2 hours of agent work. No epic tasks.

---

## Phase-level contract

Each phase file opens with:

1. **Phase goal** — one paragraph.
2. **Exit criteria** — bulleted list of capabilities the app gains, expressed as runnable behaviors (e.g. "running `npm run dev` boots the server and `curl localhost:3000/api/health` returns `{ok: true}`").
3. **Out of scope for this phase** — explicit list. Items here are deferred to later phases.

Then numbered tasks. Then a closing **Phase verification** section with a single command sequence the agent runs to confirm exit criteria before moving on.

---

## Hard invariants — restate at the top of the plan

Copy these into the top of `00-decisions.md` so the agent re-encounters them every time it consults the plan:

- YAML files are authoritative for local intended state. SQLite stores only metadata, never work item content.
- ADO `System.Rev` is authoritative for remote state. Every update JSON Patch includes a `test` op against `/rev`.
- No automatic syncing, no background push, no automatic write retry.
- Hard blockers stop operations — never patch around them.
- Pull never silently overwrites existing local YAML when the remote item changed. Confirmation popup required; default action is cancel.
- Stop-on-first-failure for batch pushes. No atomic rollback is promised.
- No force ops in MVP: no force push, no auto-rollback, no YAML deletion, no ADO work item deletion, no work-item-type changes.

---

## When the agent should pause for human input

Define this explicitly in `00-decisions.md`. Default triggers (override or extend as needed):

- Any irreversible action against the real ADO project.
- Spec ambiguity that a reasonable engineer would interpret two different ways.
- A test failure the agent cannot resolve within two attempts.
- Any mutation outside the agreed test work item subtree.
- A request to add a dependency not pre-approved in `00-decisions.md`.

Outside these triggers, the agent uses judgment and proceeds.

---

## Cross-cutting items to address explicitly

Each of these must appear somewhere in the plan, with the responsible phase named:

- Environment variable contract (spec §11.1) — where loaded, where validated, what happens on missing.
- Fixture strategy — where fixtures live, what they cover, how they're refreshed.
- ADO metadata discovery (spec §6.1) — when it runs, where results are cached.
- SQLite migrations / schema versioning — even if trivial for MVP.
- Audit log redaction (spec §16) — which phase wires it in.
- Hash canonicalization rules (spec §7) — which phase implements them.
- Multi-document YAML identity (`yaml_path` + `yaml_document_index`) — which phase enforces uniqueness.

---

## What NOT to include in the plan

- Restatement of spec content. Link to sections instead.
- Code samples beyond one-liners.
- Speculative future-phase work. Out-of-scope items go under "Out of scope here."
- Estimates in hours or story points.
- Tips, advice, "considerations." Tasks are imperative.

---

# User-supplied context

The sections below are filled in by the user before the planner runs. Treat them as authoritative inputs.

## Test ADO environment

USER_INPUT_NEEDED — Provide:
- ADO organization name (`ADO_ORG`): goalliant
- ADO project name (`ADO_PROJECT`): Alliant
- A parent work item ID (Epic or Feature) safe to mutate during agent runs: 221835
- Whether agent may create child work items under that parent during phases 3+ (yes / no): yes
- Any work item IDs that must NOT be touched: anything that ISN'T 221835

If real ADO access is not available yet, write `MOCKS ONLY` here and the planner will route phases 2–4 through HTTP fixtures until further notice.

## Authentication

The agent has access to `$ADO_PAT` exported in its shell. The planner should assume this is present and not propose code that prompts for it interactively.

USER_INPUT_NEEDED — Token scope confirmation (read-only, read+write, full): full

## Commit and PR cadence

USER_INPUT_NEEDED — Choose one:
- Commit per task on `main`

USER_INPUT_NEEDED — Should the agent push to `origin` autonomously? (yes / no): no

## Stack preferences

USER_INPUT_NEEDED — Either pin choices here, or write `Planner decides` to delegate. The spec recommends Node + Fastify + SQLite + minimal frontend (Vite or static TS), but does not require it.

- Runtime preference (Node / Bun / no preference): bun
- Frontend approach (Vite + vanilla TS / static bundle / no preference): no preference 
- Test runner preference: no preference
- Anything you definitely do NOT want as a dependency: Anything that's EOL or abandoned

## Workspace and template directories

USER_INPUT_NEEDED — Provide concrete absolute paths the agent should configure as defaults during development:

- `ADO_WORKSPACE_DIR`: /mnt/c/Users/jallen4/git/surfboard/workspace
- `ADO_TEMPLATE_DIR`: /mnt/c/Users/jallen4/git/surfboard/workspace/templates

If you want the agent to create example workspaces under `./examples/` and point env vars at them, write `agent-managed`.

## Scope adjustments

USER_INPUT_NEEDED — Any deviations from spec MVP scope (additions, removals, deferrals)? Write `none` if the spec stands as-is. none

## Pause-for-input overrides

USER_INPUT_NEEDED — Any additional triggers beyond the defaults above that should pause the agent? Write `none` if the defaults are sufficient. none

---

# Final reminder to the planner

Produce the files described above and nothing else. Do not modify the spec, `CLAUDE.md`, or any source code. Do not ask clarifying questions — every required input is collected in this prompt. If a `USER_INPUT_NEEDED` block was left blank, treat it as `Agent picks` and note that decision in `00-decisions.md`.
