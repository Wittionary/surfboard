// Live ADO read smoke for the safe parent (221835) only.
//
// Hard rule: this script never writes. It refuses to run when the configured
// org / project / parent do not match docs/plan/00-decisions.md. This guard
// stays even if the env vars drift: a typo must not point the agent at a
// production project.

import { AdoClient, getDirectChildren, getWorkItem } from "../src/server/adoClient.ts";
import { discoverAdoMetadata } from "../src/server/adoMetadata.ts";

const REQUIRED_ORG = "goalliant";
const REQUIRED_PROJECT = "Alliant";
const REQUIRED_PARENT = 221835;

const env = process.env;
const org = env.ADO_ORG ?? "";
const project = env.ADO_PROJECT ?? "";
const pat = env.ADO_PAT ?? "";
const apiVersion = env.ADO_API_VERSION ?? "7.1";
const targetParent = Number.parseInt(env.SURFBOARD_SMOKE_PARENT ?? String(REQUIRED_PARENT), 10);

if (org !== REQUIRED_ORG) {
  console.error(`[smoke-ado-read] refusing to run: ADO_ORG must be "${REQUIRED_ORG}"; got "${org}"`);
  process.exit(2);
}
if (project !== REQUIRED_PROJECT) {
  console.error(`[smoke-ado-read] refusing to run: ADO_PROJECT must be "${REQUIRED_PROJECT}"; got "${project}"`);
  process.exit(2);
}
if (targetParent !== REQUIRED_PARENT) {
  console.error(
    `[smoke-ado-read] refusing to run: parent must be ${REQUIRED_PARENT}; got ${targetParent}`,
  );
  process.exit(2);
}
if (!pat) {
  console.error("[smoke-ado-read] ADO_PAT is required");
  process.exit(2);
}

const client = new AdoClient({ organization: org, project, apiVersion, pat });

try {
  const parent = await getWorkItem(client, REQUIRED_PARENT);
  console.log(
    `[smoke-ado-read] parent: id=${parent.id} type=${parent.fields["System.WorkItemType"] ?? "?"} title=${JSON.stringify(parent.fields["System.Title"] ?? "")} rev=${parent.rev}`,
  );

  const children = await getDirectChildren(client, REQUIRED_PARENT);
  console.log(`[smoke-ado-read] direct children: ${children.length}`);
  for (const c of children) {
    console.log(
      `  - id=${c.id} type=${c.fields["System.WorkItemType"] ?? "?"} state=${c.fields["System.State"] ?? "?"} rev=${c.rev}`,
    );
  }

  const meta = await discoverAdoMetadata(client);
  console.log(
    `[smoke-ado-read] metadata: project=${meta.project.name} types=${meta.workItemTypes.length} fields=${meta.fields.length}`,
  );
} catch (err) {
  console.error("[smoke-ado-read] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
