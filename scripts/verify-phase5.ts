// Phase 5 verification: phase 4 + acceptance + MVP smoke.

import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "phase 4", command: bun, args: ["run", "scripts/verify-phase4.ts"] });
runStep({ name: "smoke-mvp", command: bun, args: ["run", "scripts/smoke-mvp.ts"] });

process.stdout.write("[verify:phase5] all checks passed\n");
