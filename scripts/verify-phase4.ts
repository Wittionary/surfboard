// Phase 4 verification: phase 3 + push fixture tests. Live write smoke is
// only run when SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes; otherwise it's skipped.

import { spawnSync } from "node:child_process";
import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "phase 3", command: bun, args: ["run", "scripts/verify-phase3.ts"] });

if (process.env.SURFBOARD_ALLOW_ADO_WRITE_SMOKE === "yes") {
  const smoke = spawnSync(bun, ["run", "scripts/smoke-ado-write.ts"], { stdio: "inherit" });
  if (smoke.status !== 0) {
    process.stderr.write(`[verify] ✗ smoke-ado-write failed (exit ${smoke.status})\n`);
    process.exit(smoke.status ?? 1);
  }
  process.stdout.write("[verify] ✓ smoke-ado-write (live)\n");
} else {
  process.stdout.write(
    "[verify] · smoke-ado-write skipped (set SURFBOARD_ALLOW_ADO_WRITE_SMOKE=yes to enable)\n",
  );
}

process.stdout.write("[verify:phase4] all checks passed\n");
