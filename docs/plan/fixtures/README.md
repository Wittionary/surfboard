# Plan Fixture Notes

Fixtures referenced by the implementation plan should be created under `tests/fixtures/`, not under `docs/plan/fixtures/`, when the implementation work begins.

This directory records fixture intent for the planner:

- Safe ADO org: `goalliant`.
- Safe ADO project: `Alliant`.
- Safe mutable parent work item: `221835`.
- The agent may create app-owned child work items under `221835`.
- The agent must not mutate any pre-existing work item other than `221835`.
- Recorded ADO responses should cover metadata discovery, parent/children pull, updates/revisions, remote deletion, push success, push failure, and webhook payloads.
- Refreshing fixtures from real ADO requires explicit human approval.

