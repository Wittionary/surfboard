// Final MVP verification: typecheck + tests + smoke (no live ADO mutation).

import { bunBin, runStep } from "./run-step.ts";

const bun = bunBin();

runStep({ name: "typecheck", command: bun, args: ["x", "tsc", "--noEmit"] });
runStep({ name: "test", command: bun, args: ["test"] });
runStep({ name: "build", command: bun, args: ["run", "scripts/build-frontend.ts"] });
runStep({ name: "smoke-mvp", command: bun, args: ["run", "scripts/smoke-mvp.ts"] });

process.stdout.write("[verify:mvp] all checks passed\n");
