// Container verification: builds the image, runs it against a temp workspace,
// polls /api/health, and tears everything down. Not part of verify:mvp because
// the image build is slow; run on demand after Dockerfile / compose changes.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthReport } from "../src/shared/types.ts";

const IMAGE_TAG = "surfboard:verify";
const CONTAINER_NAME = "surfboard-verify";
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

function run(cli: string, args: string[], opts: { check?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cli, args, { encoding: "utf8" });
  if (opts.check && result.status !== 0) {
    process.stderr.write(`[verify:container] ${cli} ${args.join(" ")} exited ${result.status}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${cli} failed`);
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Honor an explicit override, otherwise probe podman then docker. Shell aliases
// (e.g. `alias docker=podman`) do not apply to spawnSync, so we resolve the
// real binary here.
function resolveContainerCli(): string | null {
  const override = process.env.SURFBOARD_CONTAINER_CLI?.trim();
  if (override) {
    const r = spawnSync(override, ["--version"], { encoding: "utf8" });
    return r.status === 0 ? override : null;
  }
  for (const candidate of ["podman", "docker"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  return null;
}

async function pollHealth(port: number): Promise<HealthReport> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return (await res.json()) as HealthReport;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`health probe timed out: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function cleanup(cli: string, workDir: string): void {
  spawnSync(cli, ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const cli = resolveContainerCli();
  if (!cli) {
    process.stderr.write("[verify:container] no podman or docker found on PATH (set SURFBOARD_CONTAINER_CLI to override)\n");
    process.exit(1);
  }
  process.stdout.write(`[verify:container] using ${cli}\n`);

  const workDir = mkdtempSync(join(tmpdir(), "surfboard-verify-"));
  // The default ADO_TEMPLATE_DIR inside the image is /workspace/templates; the
  // workspace dir doesn't need to contain anything for /api/health to pass.

  let exitCode = 0;
  try {
    process.stdout.write("[verify:container] ▸ building image\n");
    run(cli, ["build", "-t", IMAGE_TAG, "."], { check: true });

    process.stdout.write("[verify:container] ▸ starting container\n");
    // Pick an ephemeral host port to avoid colliding with a dev server.
    const hostPort = 38000 + Math.floor((process.pid % 1000));
    run(
      cli,
      [
        "run",
        "--rm",
        "-d",
        "--name",
        CONTAINER_NAME,
        "-p",
        `127.0.0.1:${hostPort}:3000`,
        "-v",
        `${workDir}:/workspace`,
        IMAGE_TAG,
      ],
      { check: true },
    );

    process.stdout.write(`[verify:container] ▸ polling /api/health on ${hostPort}\n`);
    const report = await pollHealth(hostPort);
    if (report.sqlite.status !== "ok") {
      throw new Error(`sqlite not ok: ${JSON.stringify(report.sqlite)}`);
    }
    // Assert presence, not just status — an absent watcher means it was never
    // started, which is exactly the regression this check exists to catch.
    if (!report.watcher || report.watcher.status !== "ok") {
      throw new Error(`watcher not ok: ${JSON.stringify(report.watcher ?? null)}`);
    }
    process.stdout.write(
      `[verify:container] ok — app=${report.app.status} sqlite=${report.sqlite.status} watcher=${report.watcher?.status ?? "n/a"}\n`,
    );
  } catch (err) {
    process.stderr.write(`[verify:container] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    exitCode = 1;
  } finally {
    cleanup(cli, workDir);
  }
  process.exit(exitCode);
}

void main();
