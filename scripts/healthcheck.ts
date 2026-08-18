// Tiny health probe used by the container's HEALTHCHECK. Exits 0 when
// /api/health responds 200 with sqlite.status === "ok", non-zero otherwise.
// Lives in the image so we do not need to apt-install wget/curl.

import type { HealthReport } from "../src/shared/types.ts";

const port = process.env.SURFBOARD_PORT ?? "3000";
const url = `http://127.0.0.1:${port}/api/health`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) {
    console.error(`[healthcheck] ${url} → ${res.status}`);
    process.exit(1);
  }
  const body = (await res.json()) as HealthReport;
  if (body.sqlite.status !== "ok") {
    console.error(`[healthcheck] sqlite=${body.sqlite.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(`[healthcheck] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
