import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoteEntry, NotesBackend } from "../types.js";
import { errorResult, jsonResult, parseDisabledTools, toolEnabled } from "./helpers.js";
import { NoteNotFoundError } from "../notes/errors.js";
import { assertWritable, safeRelPath } from "../notes/paths.js";
import { isMarkdown, walkNotes } from "../notes/walk.js";
import {
  Frontmatter,
  appendToBody,
  appendToSection,
  buildFrontmatter,
  extractLinks,
  listHeadings,
  logLine,
  parseNote,
  replaceSection,
  serializeNote,
} from "../notes/okf.js";

/**
 * Config is passed in rather than read from process.env here, so tool handlers
 * stay free of transport and environment concerns. Adding an HTTP transport
 * later is then an addition at the composition root, not a rewrite of this file.
 */
export interface NotesToolConfig {
  /** The configured notes root, for error messages only. */
  notesRoot: string;
  /** Write scope, relative to the notes root. Enforced on every write. */
  memoryPrefix: string;
  /** Append a change-history line to <memoryPrefix>/log.md. Default true. */
  writeLog?: boolean;
  /** Cap on files read during a content search. Default 100. */
  maxContentFiles?: number;
  /** Injectable clock, so tests get deterministic timestamps. */
  now?: () => Date;
}

const DEFAULT_MAX_CONTENT_FILES = 100;
const SNIPPET_RADIUS = 90;

type MatchKind = "index" | "frontmatter" | "path" | "body";

/** Curated index hits outrank a lucky filename substring. */
const MATCH_PRIORITY: Record<MatchKind, number> = {
  index: 0,
  frontmatter: 1,
  path: 2,
  body: 3,
};

interface SearchHit {
  path: string;
  matchedOn: MatchKind;
  title?: string;
  description?: string;
  snippet?: string;
}

/** All whitespace-separated terms must appear, case-insensitively. */
function makeMatcher(query: string): (text: string | undefined) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    if (!text || terms.length === 0) return false;
    const haystack = text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
}

function firstTerm(query: string): string {
  return query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
}

function snippetAround(text: string, query: string): string | undefined {
  const term = firstTerm(query);
  if (!term) return undefined;
  const at = text.toLowerCase().indexOf(term);
  if (at === -1) return undefined;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

function asString(value: Frontmatter[string] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Resolve a markdown link target against the directory holding the index. */
function resolveLink(indexPath: string, target: string): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("#")) return null;
  const clean = target.split("#")[0].split("?")[0];
  if (!clean) return null;
  const dir = indexPath.includes("/") ? indexPath.slice(0, indexPath.lastIndexOf("/")) : "";
  try {
    return safeRelPath(dir ? `${dir}/${clean}` : clean);
  } catch {
    return null;
  }
}

/** Turn "people/sam-taylor.md" into "Sam Taylor" for a default note title. */
function titleFromPath(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.mdx?$/i, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Memory files are markdown. Add the extension, but never silently accept another. */
function normalizeNotePath(input: string): string {
  const rel = safeRelPath(input, "path");
  if (!rel) throw new Error("path must name a file, not the root directory");
  const name = rel.split("/").pop() ?? rel;
  if (/\.mdx?$/i.test(name)) return rel;
  if (name.includes(".")) {
    throw new Error(`Notes must be markdown files: "${rel}" should end in .md`);
  }
  return `${rel}.md`;
}

function toLeanHits(hits: SearchHit[]): Record<string, unknown>[] {
  return hits.map((hit) => {
    const lean: Record<string, unknown> = { path: hit.path, matchedOn: hit.matchedOn };
    if (hit.title) lean.title = hit.title;
    if (hit.snippet) lean.snippet = hit.snippet;
    return lean;
  });
}

export function registerNotesTools(
  server: McpServer,
  backend: NotesBackend,
  config: NotesToolConfig
): void {
  const disabled = parseDisabledTools();
  const memoryPrefix = config.memoryPrefix;
  const writeLog = config.writeLog ?? true;
  const maxContentFiles = config.maxContentFiles ?? DEFAULT_MAX_CONTENT_FILES;
  const now = config.now ?? (() => new Date());
  const stamp = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");

  /**
   * Record a change in <memoryPrefix>/log.md. Best-effort by design: the note
   * write has already succeeded by this point, so a failure here is reported
   * alongside the success rather than masquerading as a failed write.
   */
  async function appendLog(action: string, path: string, detail?: string): Promise<string | undefined> {
    if (!writeLog) return undefined;
    const logPath = `${memoryPrefix}/log.md`;
    const line = logLine(stamp(), action, path, detail);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const existing = await backend.read(logPath).catch((err) => {
          if (err instanceof NoteNotFoundError) return null;
          throw err;
        });

        if (existing === null) {
          const frontmatter = buildFrontmatter({
            title: "Change log",
            description: "Chronological record of changes Betty made to memory.",
            type: "log",
            timestamp: stamp(),
          });
          await backend.write(logPath, serializeNote(frontmatter, `# Change log\n\n${line}\n`));
          return undefined;
        }

        const parsed = parseNote(existing.text);
        await backend.write(
          logPath,
          parsed.raw + appendToBody(parsed.body, line),
          existing.etag
        );
        return undefined;
      } catch (err) {
        if (attempt === 1) {
          return `Note saved, but the change log could not be updated: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
    return undefined;
  }

  if (toolEnabled("search_notes", disabled)) {
    server.tool(
      "search_notes",
      "Search notes by text. Reads index.md files and matches filenames by default; pass content: true to also search inside note bodies and frontmatter (slower, reads each file).",
      {
        query: z.string().describe("Text to search for. All whitespace-separated terms must match."),
        dir: z
          .string()
          .optional()
          .describe("Subdirectory to scope the search to, relative to the notes root"),
        content: z
          .boolean()
          .optional()
          .describe(
            "Also read each note and search its body and frontmatter (default false — slower, one read per file)"
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default 20)"),
        verbose: z
          .boolean()
          .optional()
          .describe("Return all fields — default returns only path, matchedOn, title, snippet"),
      },
      async ({ query, dir, content, limit, verbose }) => {
        try {
          const root = safeRelPath(dir ?? "", "dir");
          const max = limit ?? 20;

          const walked = await walkNotes(backend, root);
          const markdown = walked.files.filter(isMarkdown);
          const hits = new Map<string, SearchHit>();
          const matches = makeMatcher(query);

          const record = (hit: SearchHit) => {
            const existing = hits.get(hit.path);
            if (!existing || MATCH_PRIORITY[hit.matchedOn] < MATCH_PRIORITY[existing.matchedOn]) {
              hits.set(hit.path, { ...existing, ...hit });
            } else if (!existing.snippet && hit.snippet) {
              existing.snippet = hit.snippet;
            }
          };

          // 1. Index-first. index.md files are curated by the user, so a hit
          //    here is a better answer than a filename that happens to match.
          const indexes = markdown.filter((f) => /^index\.mdx?$/i.test(f.name));
          for (const index of indexes) {
            let text: string;
            try {
              text = (await backend.read(index.path)).text;
            } catch {
              continue;
            }
            const parsed = parseNote(text);
            for (const link of extractLinks(parsed.body)) {
              if (!matches(link.text) && !matches(link.target)) continue;
              const target = resolveLink(index.path, link.target);
              if (!target) continue;
              record({ path: target, matchedOn: "index", title: link.text || undefined });
            }
            if (matches(parsed.body) || matches(asString(parsed.frontmatter.title))) {
              record({
                path: index.path,
                matchedOn: "index",
                title: asString(parsed.frontmatter.title),
                snippet: snippetAround(parsed.body, query),
              });
            }
          }

          // 2. Path and filename matching — free, straight off the listing.
          for (const file of markdown) {
            if (matches(file.path)) record({ path: file.path, matchedOn: "path" });
          }

          // 3. Content, opt-in. Frontmatter lives inside the file, so matching
          //    it costs the same read as matching the body.
          let scanned = 0;
          let contentTruncated = false;
          if (content) {
            for (const file of markdown) {
              if (scanned >= maxContentFiles) {
                contentTruncated = true;
                break;
              }
              scanned++;
              let text: string;
              try {
                text = (await backend.read(file.path)).text;
              } catch {
                continue;
              }
              const parsed = parseNote(text);
              const title = asString(parsed.frontmatter.title);
              const description = asString(parsed.frontmatter.description);
              const type = asString(parsed.frontmatter.type);

              if (matches(title) || matches(description) || matches(type)) {
                record({ path: file.path, matchedOn: "frontmatter", title, description });
              } else if (matches(parsed.body)) {
                record({
                  path: file.path,
                  matchedOn: "body",
                  title,
                  description,
                  snippet: snippetAround(parsed.body, query),
                });
              }
            }
          }

          const ordered = [...hits.values()].sort(
            (a, b) =>
              MATCH_PRIORITY[a.matchedOn] - MATCH_PRIORITY[b.matchedOn] ||
              a.path.localeCompare(b.path)
          );
          const limited = ordered.slice(0, max);

          const payload: Record<string, unknown> = {
            results: verbose ? limited : toLeanHits(limited),
          };
          if (ordered.length > limited.length) payload.moreResults = ordered.length - limited.length;
          // Never let a bounded search read as an exhaustive one.
          if (walked.truncated || contentTruncated) {
            payload.truncated = true;
            payload.truncatedReason = walked.truncated
              ? "Directory tree too large to walk fully — narrow the search with dir."
              : `Stopped after reading ${maxContentFiles} files — narrow the search with dir.`;
          }
          if (!content) {
            payload.searchedBodies = false;
          }
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("get_note", disabled)) {
    server.tool(
      "get_note",
      "Read a single note by path, returning its body, frontmatter title/type, and the list of headings available to replace_section.",
      {
        path: z.string().describe("Path to the note, relative to the notes root"),
        verbose: z
          .boolean()
          .optional()
          .describe("Return all fields — default returns only path, title, type, headings, body"),
      },
      async ({ path, verbose }) => {
        try {
          const rel = safeRelPath(path, "path");
          const note = await backend.read(rel);
          const parsed = parseNote(note.text);
          const headings = listHeadings(parsed.body).map((h) => h.text);

          if (verbose) {
            return jsonResult({
              path: rel,
              frontmatter: parsed.frontmatter,
              hasFrontmatter: parsed.hasFrontmatter,
              headings,
              body: parsed.body,
              etag: note.etag,
            });
          }

          const lean: Record<string, unknown> = { path: rel, body: parsed.body };
          const title = asString(parsed.frontmatter.title);
          const type = asString(parsed.frontmatter.type);
          if (title) lean.title = title;
          if (type) lean.type = type;
          if (headings.length > 0) lean.headings = headings;
          return jsonResult(lean);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("append_note", disabled)) {
    server.tool(
      "append_note",
      "Append content to a note, creating it with Open Knowledge Format frontmatter if it does not exist. Writes are restricted to the configured memory directory.",
      {
        path: z
          .string()
          .describe("Path to the note, relative to the notes root. Must be inside the memory root."),
        content: z.string().describe("Markdown content to append"),
        heading: z
          .string()
          .optional()
          .describe("Append under this existing heading instead of at the end of the note"),
        title: z
          .string()
          .optional()
          .describe("Title for a note being created (defaults to a title derived from the filename)"),
        description: z
          .string()
          .optional()
          .describe("One-line description for a note being created"),
        type: z
          .string()
          .optional()
          .describe("Open Knowledge Format type for a note being created (default: note)"),
      },
      async ({ path, content, heading, title, description, type }) => {
        try {
          const rel = normalizeNotePath(path);
          assertWritable(memoryPrefix, rel);

          const existing = await backend.read(rel).catch((err) => {
            if (err instanceof NoteNotFoundError) return null;
            throw err;
          });

          let text: string;
          let created: boolean;

          if (existing === null) {
            const noteTitle = title ?? titleFromPath(rel);
            const frontmatter = buildFrontmatter({
              title: noteTitle,
              description,
              type,
              timestamp: stamp(),
            });
            const body = heading
              ? `# ${noteTitle}\n\n## ${heading}\n\n${content.trim()}\n`
              : `# ${noteTitle}\n\n${content.trim()}\n`;
            text = serializeNote(frontmatter, body);
            await backend.write(rel, text);
            created = true;
          } else {
            const parsed = parseNote(existing.text);
            const body = heading
              ? appendToSection(parsed.body, heading, content)
              : appendToBody(parsed.body, content);
            text = parsed.raw + body;
            await backend.write(rel, text, existing.etag);
            created = false;
          }

          const warning = await appendLog(created ? "create" : "append", rel, heading);
          const payload: Record<string, unknown> = { path: rel, created, bytes: text.length };
          if (heading) payload.heading = heading;
          if (warning) payload.warning = warning;
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("replace_section", disabled)) {
    server.tool(
      "replace_section",
      "Replace the content under an existing heading in a note, leaving the rest of the file untouched. The heading must already exist — use append_note to add new content. Writes are restricted to the configured memory directory.",
      {
        path: z
          .string()
          .describe("Path to the note, relative to the notes root. Must be inside the memory root."),
        heading: z
          .string()
          .describe(
            "Exact text of an existing heading (from get_note). The section runs to the next heading of the same or higher level."
          ),
        content: z.string().describe("Markdown content to put under the heading"),
      },
      async ({ path, heading, content }) => {
        try {
          const rel = normalizeNotePath(path);
          assertWritable(memoryPrefix, rel);

          const existing = await backend.read(rel);
          const parsed = parseNote(existing.text);
          // Throws with the list of headings that do exist, so the model can retry.
          const body = replaceSection(parsed.body, heading, content);
          const text = parsed.raw + body;
          await backend.write(rel, text, existing.etag);

          const warning = await appendLog("replace", rel, heading);
          const payload: Record<string, unknown> = {
            path: rel,
            heading,
            replaced: true,
            bytes: text.length,
          };
          if (warning) payload.warning = warning;
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}

/** Exported for tests. */
export const __testables = { normalizeNotePath, titleFromPath, makeMatcher, resolveLink, snippetAround };
export type { NoteEntry };
