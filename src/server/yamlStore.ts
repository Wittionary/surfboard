// Multi-document YAML store per spec §5.2 and §5.3. The store reads, indexes,
// and writes individual documents while preserving siblings.
//
// Identity: (yaml_path, yaml_document_index). `metadata.localId` must be unique
// workspace-wide; that invariant is enforced by the workspace scanner, not here.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { LineCounter, parseAllDocuments, stringify as yamlStringify } from "yaml";
import type { LocalWorkItem } from "../shared/types.ts";

export type WorkspaceFile = {
  path: string;
  documentCount: number;
};

export type ParsedDocument = {
  path: string;
  documentIndex: number;
  /** Raw parsed JS value; may be null/undefined for empty docs. */
  raw: unknown;
  /** Set when the document parses to a structurally valid work item envelope. */
  content?: LocalWorkItem;
  parseError?: string;
};

export type ScanOptions = {
  /** Directory to exclude (e.g. ADO_TEMPLATE_DIR). Path comparison is exact, prefix-anchored. */
  excludeDir?: string;
};

const YAML_EXTS = new Set([".yaml", ".yml"]);

export function scanWorkspaceFiles(rootDir: string, options: ScanOptions = {}): WorkspaceFile[] {
  if (!existsSync(rootDir)) return [];
  const root = resolve(rootDir);
  const exclude = options.excludeDir ? resolve(options.excludeDir) : null;
  const files: WorkspaceFile[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    if (exclude && (dir === exclude || dir.startsWith(exclude + sep))) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!YAML_EXTS.has(extname(name).toLowerCase())) continue;
      const docs = parseYamlFile(full);
      files.push({ path: full, documentCount: docs.length });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function parseYamlFile(path: string): ParsedDocument[] {
  const text = readFileSync(path, "utf8");
  const docs = parseAllDocuments(text, { prettyErrors: true });
  const out: ParsedDocument[] = [];

  docs.forEach((doc, index) => {
    if (doc.errors.length > 0) {
      out.push({
        path,
        documentIndex: index,
        raw: undefined,
        parseError: doc.errors.map((e) => e.message).join("; "),
      });
      return;
    }
    const raw = doc.toJS();
    const content = isLocalWorkItemShape(raw) ? withLocation(raw, path, index) : undefined;
    out.push({ path, documentIndex: index, raw, content });
  });

  // Edge case: an empty file produces zero documents — surface as a single empty doc
  // so the scanner reports documentCount=1 and the validator can flag it.
  if (out.length === 0) {
    out.push({ path, documentIndex: 0, raw: undefined });
  }

  return out;
}

export function readDocument(path: string, documentIndex: number): ParsedDocument | null {
  const docs = parseYamlFile(path);
  return docs[documentIndex] ?? null;
}

/**
 * Replace the document at `documentIndex` with `item`. Preserves sibling
 * documents in the same file (their structure, not necessarily their exact
 * whitespace) per spec §5.2.
 */
export function writeDocument(path: string, documentIndex: number, item: LocalWorkItem): void {
  ensureParentDir(path);
  const values = readDocumentValues(path);
  const replacement = serializableContent(item);

  if (documentIndex < values.length) {
    values[documentIndex] = replacement;
  } else if (documentIndex === values.length) {
    values.push(replacement);
  } else {
    throw new Error(
      `writeDocument: index ${documentIndex} is beyond end of file with ${values.length} documents`,
    );
  }

  writeFileSync(path, serializeValues(values), "utf8");
}

/**
 * Append a new document to `path`, returning its index. Creates the file if
 * absent. Used by pull when YAML is missing for a remote work item.
 */
export function appendDocument(path: string, item: LocalWorkItem): number {
  ensureParentDir(path);
  const values = readDocumentValues(path);
  values.push(serializableContent(item));
  writeFileSync(path, serializeValues(values), "utf8");
  return values.length - 1;
}

/**
 * Returns the path of the file relative to the workspace root, normalized to
 * forward slashes for stable display.
 */
export function relativePath(workspaceDir: string, fullPath: string): string {
  return relative(resolve(workspaceDir), resolve(fullPath)).split(sep).join("/");
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readDocumentValues(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return [];
  return parseAllDocuments(text).map((doc) => doc.toJS());
}

function serializeValues(values: readonly unknown[]): string {
  if (values.length === 0) return "";
  // Stringify each plain JS value and join with explicit document markers.
  // This regenerates formatting (acceptable per spec §5.2) and avoids any
  // duplicate `---` markers that round-tripping parsed Documents can produce.
  return values
    .map((value) => yamlStringify(value, { lineWidth: 0 }))
    .join("---\n");
}

function isLocalWorkItemShape(value: unknown): value is LocalWorkItem {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.apiVersion !== "surfboard.ado/v1") return false;
  if (typeof obj.kind !== "string") return false;
  const meta = obj.metadata;
  if (typeof meta !== "object" || meta === null) return false;
  const localId = (meta as Record<string, unknown>).localId;
  if (typeof localId !== "string" || localId.length === 0) return false;
  const spec = obj.spec;
  if (typeof spec !== "object" || spec === null) return false;
  const fields = (spec as Record<string, unknown>).fields;
  if (typeof fields !== "object" || fields === null) return false;
  return true;
}

/**
 * Returns the 1-indexed line number for a validation issue's field path inside
 * a specific YAML document. Walks up the path when the exact node is absent
 * (e.g. missing_required_field) so the line always points somewhere meaningful.
 * Returns undefined when the file is unreadable or the path resolves to nothing.
 */
export function findIssueLine(
  yamlPath: string,
  documentIndex: number,
  field: string | undefined,
): number | undefined {
  const path = issueFieldToPath(field);
  if (!path || !existsSync(yamlPath)) return undefined;
  try {
    const raw = readFileSync(yamlPath, "utf8");
    const lineCounter = new LineCounter();
    const docs = parseAllDocuments(raw, { lineCounter });
    const doc = docs[documentIndex];
    if (!doc) return undefined;
    for (let len = path.length; len > 0; len--) {
      const node = doc.getIn(path.slice(0, len), true) as { range?: [number, number, number] | null } | null;
      const offset = node?.range?.[0];
      if (offset !== undefined) return lineCounter.linePos(offset).line;
    }
  } catch {
    // ignore parse errors — best-effort
  }
  return undefined;
}

function issueFieldToPath(field: string | undefined): string[] | null {
  if (!field) return null;
  // ADO field reference names contain dots, so split only at the prefix boundary.
  if (field.startsWith("spec.fields.")) return ["spec", "fields", field.slice("spec.fields.".length)];
  return field.split(".");
}

function withLocation(item: LocalWorkItem, path: string, index: number): LocalWorkItem {
  return { ...item, yamlPath: path, yamlDocumentIndex: index };
}

function serializableContent(item: LocalWorkItem): Record<string, unknown> {
  // Strip the synthetic yamlPath/yamlDocumentIndex fields when writing back.
  const { yamlPath: _yamlPath, yamlDocumentIndex: _yamlDocumentIndex, ...payload } = item;
  return payload;
}
