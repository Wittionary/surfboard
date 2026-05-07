import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "phase 1", command: bun, args: ["run", "scripts/verify-phase1.ts"] });
runStep({ name: "smoke-local-validation", command: bun, args: ["run", "scripts/smoke-local-validation.ts"] });

process.stdout.write("[verify:phase2] all checks passed\n");
