// Bundles the frontend with Bun.build into dist/frontend/.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const srcDir = resolve(projectRoot, "src/frontend");
const outDir = resolve(projectRoot, "dist/frontend");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(srcDir, "app.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
});

if (!result.success) {
  console.error("[build-frontend] failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

copyFileSync(resolve(srcDir, "index.html"), resolve(outDir, "index.html"));
copyFileSync(resolve(srcDir, "styles.css"), resolve(outDir, "styles.css"));

console.log(`[build-frontend] wrote ${result.outputs.length + 2} files to ${outDir}`);
