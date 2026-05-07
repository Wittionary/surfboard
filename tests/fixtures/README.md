# Test fixtures

Fixture data lives here so tests can run without network access. Categories are stable; later phases add files but do not move folders.

## Categories

- `workspace-empty/` — an empty workspace skeleton (templates and workitems folders only). Used by config and migration tests that need a real path but no content. Phase 1.
- `workspace-basic/` — a minimal workspace with one Epic, one Feature, one PBI, and example multi-document YAML. Added in Phase 2.
- `templates/` — reusable Epic, Feature, PBI, Enabler, and Task template files. Added in Phase 2.
- `yaml/` — focused YAML samples (multi-doc, malformed, edge cases). Added in Phase 2.
- `ado/` — recorded ADO REST responses (work items, updates, types, fields, deleted). Added in Phase 3.
- `acceptance/` — full MVP acceptance scenarios per spec §19. Added in Phase 5.

## Hard rules

- Fixture YAML must use `localId` and `adoId` values that are clearly app-owned. Do not embed the production ADO IDs of other teams.
- The only pre-existing real ADO work item the implementation may mutate is `221835`. Fixture data must not reference any other real production ID as a mutation target. See `docs/plan/fixtures/safe-ado-ids.md`.
- Fixtures referenced by acceptance tests must not contain real PATs, tokens, or auth headers.

## Refresh policy

- ADO recorded responses are refreshed manually against the test parent (`221835`) during phase smoke tasks. They must be sanitized of any tokens before being committed.
- Adding or editing a fixture is a normal task commit; do not rewrite history to remove or rename fixtures.
