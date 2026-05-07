// Helper used by verify:phase* scripts so they share consistent step output.

import { spawnSync } from "node:child_process";

export type Step = {
  name: string;
  command: string;
  args: string[];
};

export function runStep(step: Step): void {
  process.stdout.write(`[verify] ▸ ${step.name}\n`);
  const start = Date.now();
  const result = spawnSync(step.command, step.args, { stdio: "inherit" });
  const ms = Date.now() - start;
  if (result.status !== 0) {
    process.stderr.write(`[verify] ✗ ${step.name} (${ms} ms, exit ${result.status})\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`[verify] ✓ ${step.name} (${ms} ms)\n`);
}

export function bunBin(): string {
  return process.execPath;
}
