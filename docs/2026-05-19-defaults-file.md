# 2026-05-19 Defaults File

Surfboard work item YAML should stay concise without losing deterministic sync behavior. This change adds a workspace-owned defaults document under `workspace/templates/` that supplies effective default values for work items during validation, hashing, patch generation, and pull/write normalization.

The core behavior is: authored work item YAML wins over defaults. Defaults are applied only to compute the effective work item used by Surfboard. The authored YAML should not be expanded just because defaults exist, and pulled YAML should omit values that are already supplied by defaults.

## Decisions

- Defaults live in the configured template directory, normally `workspace/templates/`.
- The filename is irrelevant as long as it ends in `.yaml` or `.yml`.
- The defaults document is identified by `kind: WorkItemDefaults`.
- The defaults file supports one YAML document only.
- Defaults are kind-scoped and may also include global defaults.
- Precedence is `global < kind < work item YAML`.
- Defaults may apply to `metadata`, `spec.fields`, and `spec.tags`.
- Map values merge by key.
- Work item tags replace default tags as a whole.
- Malformed defaults produce warnings only.
- Required-field validation, field hashes, relation hashes, and ADO patches use effective work items.
- Pull-created and pull-overwritten YAML omits values that match effective defaults.

Expected shape:

```yaml
apiVersion: surfboard.ado/v1
kind: WorkItemDefaults
metadata:
  name: workspace-defaults
spec:
  global:
    metadata: {}
    tags:
      - team-default
    fields:
      System.AreaPath: Alliant
  kinds:
    PBI:
      fields:
        Custom.Product: MyProduct
        Microsoft.VSTS.Common.Priority: 2
```

## Phase 1 - Discover And Parse Defaults

**Goal:** The template loader recognizes one `WorkItemDefaults` document in `workspace/templates/` without disrupting existing `WorkItemTemplate` loading.

**Implementation notes:**

- Extend `src/server/templateStore.ts` so `loadTemplates()` dispatches documents by `kind`.
- Keep `WorkItemTemplate` parsing behavior intact.
- Add a `WorkItemDefaults` type and include `defaults?: WorkItemDefaults` on `TemplateLoadResult`.
- Accept defaults from any `.yaml` or `.yml` file in the template directory.
- Treat malformed defaults, duplicate defaults, or multi-document defaults files as warnings.
- If duplicate defaults are present, use the deterministic first document by scan order and warn on the rest.
- Unknown template-directory document kinds should warn without blocking template loading.

**Acceptance criteria:**

- A defaults document named `defaults.yaml`, `workitem-defaults.yml`, or any other YAML filename loads when `kind: WorkItemDefaults`.
- Existing work item templates still load and duplicate template detection still works.
- A valid defaults document does not create a `template_malformed` error just because it is not `WorkItemTemplate`.
- A malformed defaults document produces a warning and does not prevent templates from loading.
- A defaults file with more than one YAML document produces a warning and only document 0 is used.
- Multiple defaults documents produce warnings and a deterministic first defaults document is selected.

**Verify:**

```bash
bun test tests/server/templateStore.test.ts
bun run typecheck
```

## Phase 2 - Build Effective Work Items

**Goal:** Surfboard can compute an effective work item by applying defaults without mutating the authored YAML model.

**Implementation notes:**

- Add a focused helper, likely `src/server/defaults.ts`.
- Export `applyDefaults(item, defaults): LocalWorkItem`.
- Apply defaults in this order: global defaults, kind defaults, authored work item.
- Merge `metadata` and `spec.fields` by key.
- Replace `spec.tags` as a whole when the authored work item specifies tags.
- Preserve `apiVersion`, `kind`, `yamlPath`, and `yamlDocumentIndex` from the authored item.
- Keep the helper pure: no disk writes, no cache writes, no mutation of the input item.

**Acceptance criteria:**

- A PBI inherits global fields and PBI-specific fields when omitted from the item YAML.
- A work item value overrides the same global or kind default value.
- A kind default overrides the same global default value.
- Default metadata keys are present in the effective item unless the work item supplies them.
- Work item tags replace default tags instead of merging with them.
- The original parsed work item object remains unchanged after applying defaults.

**Verify:**

```bash
bun test tests/server/defaults.test.ts
bun run typecheck
```

## Phase 3 - Validate Using Effective Values

**Goal:** Workspace validation treats defaulted values as present while still reporting defaults-file issues as warnings.

**Implementation notes:**

- In `src/server/workspace.ts`, apply defaults before per-document validation and workspace-level validation.
- Preserve authored document location in validation issues.
- Keep workspace scanning and indexing behavior metadata-only.
- Ensure required template fields can be satisfied by defaults.
- Ensure invalid defaulted values are validated by existing field rules.

**Acceptance criteria:**

- A work item missing a required field passes validation when the field is supplied by defaults.
- A work item still fails validation when neither YAML nor defaults supply a required field.
- A defaulted field with the wrong type or invalid enum value is reported against the work item using it.
- Duplicate local ID and duplicate sibling title checks run against effective items.
- Defaults warnings appear in the aggregate workspace issues but do not block valid work item scans.

**Verify:**

```bash
bun test tests/server/schemaValidation.test.ts
bun test tests/server/workspaceScanner.test.ts
bun run typecheck
```

## Phase 4 - Hash And Push Effective Values

**Goal:** Sync decisions and ADO patches use effective work item values, so omitted defaults behave the same as explicit YAML values.

**Implementation notes:**

- Ensure `fieldHash()` and `relationHash()` are called with effective items wherever defaults are available.
- Ensure push prevalidation uses effective items.
- Ensure `buildCreatePatch()` and `buildUpdatePatch()` receive effective items.
- Keep file drift detection based on authored YAML file content.
- Update accepted baselines using effective field and relation hashes.

**Acceptance criteria:**

- A work item with an explicit field and a work item inheriting the same field from defaults produce the same field hash.
- A defaulted field appears in the create patch when the authored YAML omits it.
- A defaulted field appears in the update patch when the authored YAML omits it.
- A work item overridden value appears in the patch instead of the default value.
- Push prevalidation does not block for a required field supplied by defaults.
- Accepted baselines use effective values, so a subsequent scan does not report `local_changed` just because defaulted values are omitted from YAML.

**Verify:**

```bash
bun test tests/server/hash.test.ts
bun test tests/server/patchBuilder.test.ts
bun test tests/server/pushPrevalidation.test.ts
bun test tests/server/pushCreateChild.test.ts
bun test tests/server/pushUpdate.test.ts
bun run typecheck
```

## Phase 5 - Omit Matching Defaults On Pull Writes

**Goal:** Pull-created and pull-overwritten YAML stays concise by omitting values that are already supplied by defaults.

**Implementation notes:**

- Add a helper such as `omitDefaults(item, defaults): LocalWorkItem`.
- Use it immediately before `appendDocument()` and `writeDocument()` during pull create-missing and confirmed overwrite flows.
- Compare against the defaults that apply to the remote item's kind.
- Omit matching `metadata`, `spec.fields`, and `spec.tags` values.
- Do not omit identity or location fields needed for stable local operation unless the existing model and validation can still safely recover them.
- Compute accepted baselines from the effective item, not the omitted authored item.

**Acceptance criteria:**

- Pull-created YAML omits a field when the remote value exactly matches the applicable default.
- Pull-overwritten YAML omits a field when the remote value exactly matches the applicable default.
- Pull-created YAML keeps a field when the remote value differs from the default.
- Pull-created YAML omits tags only when the full remote tag list matches the applicable default tags.
- Pull writes still include enough metadata for the item to be parsed and indexed.
- Cache baselines after pull are based on effective values and remain stable after workspace refresh.

**Verify:**

```bash
bun test tests/server/pullCreateMissing.test.ts
bun test tests/server/pullOverwriteConfirmation.test.ts
bun run typecheck
```

## Phase 6 - End-To-End Workspace Behavior

**Goal:** Defaults work through the normal local API and UI-facing validation paths without changing the safety contract.

**Implementation notes:**

- Route-level validate, refresh, pull, and push flows should all observe the same effective item behavior.
- No frontend-specific defaults logic should be needed; the backend should return normal validation and operation results.
- Existing safety rules remain unchanged: no background push, no force push, no YAML delete, no ADO delete, and every update patch keeps the `/rev` test op.

**Acceptance criteria:**

- `POST /api/workspace/refresh` indexes work items whose required fields come from defaults.
- `POST /api/validate` reports no missing-required-field issue for values supplied by defaults.
- Push routes send effective defaulted values to ADO mocks.
- Pull routes write concise YAML that omits values matching defaults.
- Existing frontend tests continue to pass without requiring defaults-specific UI behavior.
- Full repo checks remain green.

**Verify:**

```bash
bun test tests/server/localRoutes.test.ts
bun test tests/server/pushRoutes.test.ts
bun test tests/server/pullRoutes.test.ts
bun test tests/frontend/validationModal.test.ts
bun run check
bun run build
```

## Final Done Criteria

- The defaults document is documented and covered by fixtures.
- All phase-specific verification commands pass.
- `bun test`, `bun run typecheck`, `bun run check`, and `bun run build` pass.
- Existing workspaces without a defaults document behave as they do today.
- Existing sync safety guarantees remain unchanged.
