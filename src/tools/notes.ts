import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoteEntry, NotesBackend } from "../types.js";
import { errorResult, jsonResult, parseDisabledTools, toolEnabled } from "./helpers.js";
import { NoteNotFoundError } from "../notes/errors.js";
import { assertWritable, isUnderPrefix, safeRelPath } from "../notes/paths.js";
import { isMarkdown, walkNotes } from "../notes/walk.js";
import {
  Frontmatter,
  appendToBody,
  appendToSection,
  buildFrontmatter,
  extractLinks,
  findSection,
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
  /** Memory root, relative to the notes root. Writable, and searched. */
  memoryPrefix: string;
  /**
   * Desk root, relative to the notes root. Writable, and pruned from search:
   * this is where log.md and unfiled.md live, and Betty's bookkeeping has no
   * business competing with real memories in a recall query.
   */
  deskPrefix: string;
  /** Trash root, relative to the notes root. Writable, and pruned from search. */
  trashPrefix: string;
  /** Append a change-history line to <deskPrefix>/log.md. Default true. */
  writeLog?: boolean;
  /** Append a line to <deskPrefix>/unfiled.md. Default true. */
  writeUnfiled?: boolean;
  /** Cap on files read during a content search. Default 100. */
  maxContentFiles?: number;
  /** Injectable clock, so tests get deterministic timestamps. */
  now?: () => Date;
}

const DEFAULT_MAX_CONTENT_FILES = 100;
const SNIPPET_RADIUS = 90;
/** The heading organize-desk drains with replace_memory_section. */
const UNFILED_SECTION = "Unprocessed";

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
function normalizeNotePath(input: string, label = "path"): string {
  const rel = safeRelPath(input, label);
  if (!rel) throw new Error(`${label} must name a file, not the root directory`);
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
  const { memoryPrefix, deskPrefix, trashPrefix } = config;
  // Betty's memory-side roots. Skills are writable too, but through
  // registerSkillsTools — a tool named for memory should not be able to
  // silently produce a skill.
  const writePrefixes = [memoryPrefix, deskPrefix, trashPrefix];
  // Bookkeeping never appears in a recall query. This is the invariant that
  // lets automatic writes exist at all: everything code writes lands in the
  // desk, and search never looks there.
  const searchExclusions = [deskPrefix, trashPrefix];
  const writeLog = config.writeLog ?? true;
  const writeUnfiled = config.writeUnfiled ?? true;
  const maxContentFiles = config.maxContentFiles ?? DEFAULT_MAX_CONTENT_FILES;
  const now = config.now ?? (() => new Date());
  const stamp = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");

  const logPath = `${deskPrefix}/log.md`;
  const unfiledPath = `${deskPrefix}/unfiled.md`;

  /** Serialize a memory Betty is creating from scratch. Always OKF. */
  function newFileText(
    rel: string,
    opts: { content: string; heading?: string; title?: string; description?: string; type?: string }
  ): { text: string; title: string } {
    const title = opts.title?.trim() || titleFromPath(rel);
    const body = opts.heading
      ? `# ${title}\n\n## ${opts.heading}\n\n${opts.content.trim()}\n`
      : `# ${title}\n\n${opts.content.trim()}\n`;
    const frontmatter = buildFrontmatter({
      title,
      description: opts.description,
      type: opts.type,
      timestamp: stamp(),
    });
    return { text: serializeNote(frontmatter, body), title };
  }

  /**
   * Run a desk write that must never fail the memory write that triggered it.
   * By this point the memory is already saved, so a failure here is reported
   * alongside the success rather than masquerading as a failed write.
   *
   * One retry, because the desk now has two writers by design — this code and
   * the organize-desk skill — so losing an etag race is routine, not exotic.
   */
  async function bestEffort(what: string, op: () => Promise<void>): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await op();
        return undefined;
      } catch (err) {
        if (attempt === 1) {
          return `Note saved, but ${what} could not be updated: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
    return undefined;
  }

  /**
   * Append a line to a desk file, creating it with OKF frontmatter if absent.
   * Links are root-relative: desk files are pruned from search, so resolveLink
   * never touches them, and a root-relative path is the unambiguous form for
   * the organize-desk skill to act on.
   */
  async function appendDeskLine(
    path: string,
    line: string,
    fresh: { title: string; description: string; section?: string }
  ): Promise<void> {
    const existing = await backend.read(path).catch((err) => {
      if (err instanceof NoteNotFoundError) return null;
      throw err;
    });

    if (existing === null) {
      const frontmatter = buildFrontmatter({
        title: fresh.title,
        description: fresh.description,
        type: "log",
        timestamp: stamp(),
      });
      const body = fresh.section
        ? `# ${fresh.title}\n\n## ${fresh.section}\n\n${line}\n`
        : `# ${fresh.title}\n\n${line}\n`;
      await backend.write(path, serializeNote(frontmatter, body));
      return;
    }

    const parsed = parseNote(existing.text);
    // appendToSection throws when the heading is missing, which would turn a
    // hand-edited desk file into a warning on every single write. Probe first
    // and re-add the heading instead; the next write then finds it.
    const body =
      fresh.section && findSection(parsed.body, fresh.section)
        ? appendToSection(parsed.body, fresh.section, line)
        : fresh.section
          ? appendToBody(parsed.body, `## ${fresh.section}\n\n${line}`)
          : appendToBody(parsed.body, line);
    await backend.write(path, parsed.raw + body, existing.etag);
  }

  /** Record a change in <deskPrefix>/log.md. */
  async function appendLog(action: string, path: string, detail?: string): Promise<string | undefined> {
    if (!writeLog) return undefined;
    const line = logLine(stamp(), action, path, detail);
    return bestEffort("the change log", () =>
      appendDeskLine(logPath, line, {
        title: "Change log",
        description: "Chronological record of changes Betty made to memory.",
      })
    );
  }

  /**
   * Record a memory as not yet filed, in <deskPrefix>/unfiled.md. Creations
   * land here so organize-desk knows to file them under a category in the
   * memory index; moves land here because a moved memory leaves a stale link
   * behind in that index, and this is how the skill learns to reconcile it.
   *
   * Deliberately not called an inbox: Betty also does email, and "inbox" there
   * means the mail inbox to every user and every model. "Unfiled" names the
   * state instead, and pairs with index.md — unfiled is what isn't in it yet.
   */
  async function appendUnfiled(action: string, path: string, detail?: string): Promise<string | undefined> {
    // Bookkeeping does not queue itself for triage.
    if (!writeUnfiled) return undefined;
    if (isUnderPrefix(deskPrefix, path) || isUnderPrefix(trashPrefix, path)) return undefined;
    const line = logLine(stamp(), action, path, detail);
    return bestEffort("the unfiled list", () =>
      appendDeskLine(unfiledPath, line, {
        title: "Unfiled",
        description: "Memories not yet filed into the memory index by organize-desk.",
        section: UNFILED_SECTION,
      })
    );
  }

  if (toolEnabled("search_notes", disabled)) {
    server.tool(
      "search_notes",
      "Search notes by text. Reads index.md files and matches filenames by default; pass content: true to also search inside note bodies and frontmatter (slower, reads each file). Betty's desk and trash folders are skipped unless dir points into them.",
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

          const walked = await walkNotes(backend, root, { exclude: searchExclusions });
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

          // 1. Index-first. index.md files are curated — by the user for their
          //    own notes, by the organize-desk skill for Betty's memory — so a
          //    hit here is a better answer than a filename that happens to
          //    match. Nothing in code writes an index, which is what keeps this
          //    ranking honest.
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
      "Read a single note by path, returning its body, frontmatter title/type, and the list of headings available to replace_memory_section. Reads anywhere under the notes root, including Betty's desk and trash.",
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

  if (toolEnabled("append_memory", disabled)) {
    server.tool(
      "append_memory",
      `Append content to a memory, creating it with Open Knowledge Format frontmatter if it does not exist. Writes are restricted to Betty's memory ("${memoryPrefix}/"), desk ("${deskPrefix}/"), and trash; the rest of the notes root is readable but not writable. Use append_skill for skills.`,
      {
        path: z
          .string()
          .describe(
            `Path to the memory, relative to the notes root. Must be inside "${memoryPrefix}/", "${deskPrefix}/", or "${trashPrefix}/".`
          ),
        content: z.string().describe("Markdown content to append"),
        heading: z
          .string()
          .optional()
          .describe("Append under this existing heading instead of at the end of the note"),
        title: z
          .string()
          .optional()
          .describe("Title for a memory being created (defaults to a title derived from the filename)"),
        description: z
          .string()
          .optional()
          .describe("One-line description for a memory being created"),
        type: z
          .string()
          .optional()
          .describe("Open Knowledge Format type for a memory being created (default: note)"),
      },
      async ({ path, content, heading, title, description, type }) => {
        try {
          const rel = normalizeNotePath(path);
          assertWritable(writePrefixes, rel);

          const existing = await backend.read(rel).catch((err) => {
            if (err instanceof NoteNotFoundError) return null;
            throw err;
          });

          let text: string;
          let docTitle: string;
          let created: boolean;

          if (existing === null) {
            const fresh = newFileText(rel, { content, heading, title, description, type });
            text = fresh.text;
            docTitle = fresh.title;
            await backend.write(rel, text);
            created = true;
          } else {
            const parsed = parseNote(existing.text);
            const body = heading
              ? appendToSection(parsed.body, heading, content)
              : appendToBody(parsed.body, content);
            text = parsed.raw + body;
            docTitle = asString(parsed.frontmatter.title) ?? titleFromPath(rel);
            await backend.write(rel, text, existing.etag);
            created = false;
          }

          const warnings: string[] = [];
          const logWarning = await appendLog(created ? "create" : "append", rel, heading);
          if (logWarning) warnings.push(logWarning);
          if (created) {
            const unfiledWarning = await appendUnfiled("create", rel, docTitle);
            if (unfiledWarning) warnings.push(unfiledWarning);
          }

          const payload: Record<string, unknown> = { path: rel, created, bytes: text.length };
          if (heading) payload.heading = heading;
          if (warnings.length > 0) payload.warning = warnings.join(" ");
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("replace_memory_section", disabled)) {
    server.tool(
      "replace_memory_section",
      "Replace the content under an existing heading in a memory, leaving the rest of the file untouched. The heading must already exist — use append_memory to add new content. Writes are restricted to Betty's memory, desk, and trash.",
      {
        path: z
          .string()
          .describe(`Path to the memory, relative to the notes root. Must be inside "${memoryPrefix}/", "${deskPrefix}/", or "${trashPrefix}/".`),
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
          assertWritable(writePrefixes, rel);

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

  if (toolEnabled("move_memory", disabled)) {
    server.tool(
      "move_memory",
      `Move or rename a memory. Refuses to overwrite — the destination must not already exist. There is no delete: retire a memory by moving it under "${trashPrefix}/", where it stops appearing in searches but stays readable by path.`,
      {
        from: z.string().describe("Current path of the memory, relative to the notes root"),
        to: z
          .string()
          .describe(
            `New path, relative to the notes root. Must not already exist, and must be inside "${memoryPrefix}/", "${deskPrefix}/", or "${trashPrefix}/".`
          ),
      },
      async ({ from, to }) => {
        try {
          const src = normalizeNotePath(from, "from");
          const dst = normalizeNotePath(to, "to");
          // Both ends, always. Guarding only the source would let a memory be
          // moved out into the user's own vault; guarding only the destination
          // would let one of the user's notes be relocated in. Either is a
          // write outside Betty's roots.
          assertWritable(writePrefixes, src);
          assertWritable(writePrefixes, dst);
          if (src === dst) {
            throw new Error(`"${src}" is already where it is — nothing to move.`);
          }

          await backend.move(src, dst);

          const warnings: string[] = [];
          // Log the destination: the log's markdown link should point at a file
          // that still exists.
          const logWarning = await appendLog("move", dst, `from ${src}`);
          if (logWarning) warnings.push(logWarning);
          const unfiledWarning = await appendUnfiled("move", dst, `moved from ${src}`);
          if (unfiledWarning) warnings.push(unfiledWarning);

          const payload: Record<string, unknown> = { from: src, to: dst, moved: true };
          if (warnings.length > 0) payload.warning = warnings.join(" ");
          return jsonResult(payload);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}

/** Exported for tests. */
export const __testables = {
  normalizeNotePath,
  titleFromPath,
  makeMatcher,
  resolveLink,
  snippetAround,
};
export type { NoteEntry };
