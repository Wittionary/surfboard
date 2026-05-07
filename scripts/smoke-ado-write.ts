// Live ADO write smoke. Creates and updates ONE child under safe parent 221835.
// Never deletes. Refuses to run without explicit opt-in or with a different
// org/project/parent.

import { AdoClient } from "../src/server/adoClient.ts";
import { buildCreatePatch, buildUpdatePatch, workItemUrl } from "../src/server/patchBuilder.ts";
import type { AdoWorkItem } from "../src/server/adoClient.ts";
import type { LocalWorkItem } from "../src/shared/types.ts";

const REQUIRED_ORG = "goalliant";
const REQUIRED_PROJECT = "Alliant";
const REQUIRED_PARENT = 221835;

const env = process.env;
if (env.SURFBOARD_ALLOW_ADO_WRITE_SMOKE !== "yes") {
  console.error(
    "[smoke-ado-write] refusing to run without SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes",
  );
  process.exit(2);
}
if (env.ADO_ORG !== REQUIRED_ORG) {
  console.error(`[smoke-ado-write] ADO_ORG must be "${REQUIRED_ORG}"`);
  process.exit(2);
}
if (env.ADO_PROJECT !== REQUIRED_PROJECT) {
  console.error(`[smoke-ado-write] ADO_PROJECT must be "${REQUIRED_PROJECT}"`);
  process.exit(2);
}
if (!env.ADO_PAT) {
  console.error("[smoke-ado-write] ADO_PAT is required");
  process.exit(2);
}
const targetParent = Number.parseInt(env.SURFBOARD_SMOKE_PARENT ?? String(REQUIRED_PARENT), 10);
if (targetParent !== REQUIRED_PARENT) {
  console.error(`[smoke-ado-write] parent must be ${REQUIRED_PARENT}`);
  process.exit(2);
}

const client = new AdoClient({
  organization: REQUIRED_ORG,
  project: REQUIRED_PROJECT,
  apiVersion: env.ADO_API_VERSION ?? "7.1",
  pat: env.ADO_PAT,
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const title = `Surfboard smoke ${stamp}`;
const local: LocalWorkItem = {
  apiVersion: "surfboard.ado/v1",
  kind: "PBI",
  metadata: { localId: `pbi-smoke-${stamp}` },
  spec: {
    parent: { adoId: REQUIRED_PARENT },
    fields: {
      "System.Title": title,
      "System.Description": "Created by Surfboard smoke-ado-write. Safe to delete.",
      // Required by the Alliant project's process customization. The smoke
      // uses "Other" as the most generic safe value; real PBIs should set
      // Custom.Product appropriately for the team that owns them.
      "Custom.Product": "Other",
    },
  },
  yamlPath: "smoke",
  yamlDocumentIndex: 0,
};

try {
  const createPatch = buildCreatePatch({
    item: local,
    parentUrl: workItemUrl(REQUIRED_ORG, REQUIRED_PARENT),
  });
  const created = await client.patchJson<AdoWorkItem>(
    `wit/workitems/$Product%20Backlog%20Item`,
    createPatch,
  );
  console.log(`[smoke-ado-write] created: id=${created.id} rev=${created.rev} title=${title}`);

  // Refuse to update anything other than the just-created child.
  if (created.id <= 0 || created.id === REQUIRED_PARENT) {
    console.error(`[smoke-ado-write] refusing to update id=${created.id}`);
    process.exit(1);
  }
  if (
    typeof created.fields["System.Parent"] === "number" &&
    created.fields["System.Parent"] !== REQUIRED_PARENT
  ) {
    console.error(
      `[smoke-ado-write] refusing to update id=${created.id}: parent=${created.fields["System.Parent"]} not ${REQUIRED_PARENT}`,
    );
    process.exit(1);
  }

  const updatedLocal: LocalWorkItem = {
    ...local,
    metadata: { ...local.metadata, adoId: created.id },
    spec: {
      ...local.spec,
      fields: {
        ...local.spec.fields,
        "System.Title": `${title} (updated)`,
      },
    },
  };
  const updatePatch = buildUpdatePatch({
    item: updatedLocal,
    cachedRev: created.rev,
    remote: created,
  });
  const updated = await client.patchJson<AdoWorkItem>(
    `wit/workitems/${created.id}`,
    updatePatch,
  );
  console.log(`[smoke-ado-write] updated: id=${updated.id} rev=${updated.rev}`);
  console.log(
    `[smoke-ado-write] ok — created+updated child ${updated.id} under parent ${REQUIRED_PARENT}`,
  );
} catch (err) {
  console.error("[smoke-ado-write] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
