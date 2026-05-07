import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "typecheck", command: bun, args: ["x", "tsc", "--noEmit"] });
runStep({ name: "test", command: bun, args: ["test"] });
runStep({ name: "build", command: bun, args: ["run", "scripts/build-frontend.ts"] });
runStep({ name: "smoke-health", command: bun, args: ["run", "scripts/smoke-health.ts"] });

process.stdout.write("[verify:phase1] all checks passed\n");
