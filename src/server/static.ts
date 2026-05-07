// Serves bundled frontend assets from dist/frontend.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type StaticOptions = {
  root: string;
};

function pickMime(path: string): string {
  for (const [ext, mime] of Object.entries(MIME)) {
    if (path.endsWith(ext)) return mime;
  }
  return "application/octet-stream";
}

export function registerStatic(app: FastifyInstance, options: StaticOptions): void {
  const root = resolve(options.root);

  app.get("/", async (_req, reply) => {
    const indexPath = resolve(root, "index.html");
    if (!existsSync(indexPath)) {
      return reply.code(404).send({ error: "frontend assets missing; run `bun run build`" });
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(readFileSync(indexPath));
  });

  app.get<{ Params: { "*": string } }>("/assets/*", async (req, reply) => {
    const subpath = req.params["*"] ?? "";
    const requested = normalize(resolve(root, subpath));
    if (!requested.startsWith(root + sep) && requested !== root) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!existsSync(requested)) return reply.code(404).send({ error: "not found" });
    const stat = statSync(requested);
    if (!stat.isFile()) return reply.code(404).send({ error: "not found" });
    return reply.type(pickMime(requested)).send(readFileSync(requested));
  });
}
