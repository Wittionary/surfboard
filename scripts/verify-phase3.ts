// Phase 3 verification: phase 2 + ADO fixture tests + optional live read smoke.

import { spawnSync } from "node:child_process";
import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "phase 2", command: bun, args: ["run", "scripts/verify-phase2.ts"] });

// Live ADO read smoke is optional: it only runs when ADO env is configured
// and the org/project/parent match the safe decisions. The script itself
// refuses to run with a non-zero exit code when guards fail; we treat exit
// code 2 (configuration mismatch) as a soft skip so verify still passes
// without ADO credentials, but exit codes 0 (success) and 1 (live failure)
// surface to the caller.
const smoke = spawnSync(bun, ["run", "scripts/smoke-ado-read.ts"], { stdio: "inherit" });
if (smoke.status === 0) {
  process.stdout.write("[verify] ✓ smoke-ado-read (live)\n");
} else if (smoke.status === 2) {
  process.stdout.write("[verify] · smoke-ado-read skipped (no live ADO config)\n");
} else {
  process.stderr.write(`[verify] ✗ smoke-ado-read failed (exit ${smoke.status})\n`);
  process.exit(smoke.status ?? 1);
}

process.stdout.write("[verify:phase3] all checks passed\n");
