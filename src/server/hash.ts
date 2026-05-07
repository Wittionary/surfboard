// Canonical hashing helpers per spec §7. Field/relation hashes derive from
// canonically normalized data so YAML formatting and comments do not produce
// false content changes.
//
// Phase 2.4 only needs the file hash. Task 2.6 expands this with field and
// relation canonicalization.

import { createHash } from "node:crypto";

export function fileSha256(content: Buffer | string): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
