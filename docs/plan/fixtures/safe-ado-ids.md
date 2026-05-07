# Safe ADO IDs

- `221835`: the only pre-existing ADO work item the implementation agent may mutate.
- App-created children under `221835`: safe to create and update during explicitly enabled write-smoke tests.
- Any other pre-existing ADO work item: do not mutate.

