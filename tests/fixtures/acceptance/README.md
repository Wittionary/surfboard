# MVP acceptance fixtures

Files in this directory back the spec §19.1 must-pass flows and the §19.2 scale
shapes. They are HTTP-recorded payloads (or programmatically generated YAML)
and never embed real PATs or live ADO IDs other than the safe parent
(`221835`, when applicable).

The acceptance test (`tests/acceptance/mvp.test.ts`) drives the local server
through its real routes against an injected `AdoClient` whose fetch is fed by
these fixtures. No live ADO calls happen during the suite.

Refresh policy: regenerate by re-running the Phase 3/4 smoke scripts and
sanitizing the output through `redact()`.
