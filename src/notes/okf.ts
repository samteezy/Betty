/**
 * Open Knowledge Format (OKF v0.1) support — markdown with YAML frontmatter,
 * one concept per file, interlinked with plain markdown links, `index.md` for
 * directory listings and `log.md` for change history.
 *
 * The frontmatter parser handles the scalar/list subset OKF actually uses.
 * That is deliberate: pulling in js-yaml for four keys would break the
 * zero-runtime-dependency principle for no real gain.
 *
 * The parse/serialize half is format-agnostic, so `SKILL.md` manifests — which
 * are markdown-with-frontmatter but explicitly not OKF — are written from here
 * too, via `buildSkillFrontmatter`.
 */

/** Frontmatter values are scalars or simple lists — no nested maps. */
export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
  hasFrontmatter: boolean;
  /**
   * The frontmatter block verbatim, delimiters included (or "" when absent).
   * Edits reattach this untouched rather than re-serializing, so Betty never
   * reformats a human's frontmatter as a side effect of appending a line.
   */
  raw: string;
}

/**
 * OKF v0.1 requires only `type`, but Google's own reference parser expects
 * all four of these, so Betty always writes all four. `source` is Betty's
 * own addition: everything she wrote stays greppable and deletable in bulk.
 */
export const BETTY_SOURCE = "betty";
export const REQUIRED_FRONTMATTER = ["type", "title", "description", "timestamp"];

/**
 * A `SKILL.md` is a skill manifest, not an OKF note: `list_skills` reads `name`
 * and `description` and skips a folder whose SKILL.md has neither. Leading with
 * those two keeps a skill Betty writes identical in shape to one written by
 * hand, or for another tool.
 */
export const SKILL_FRONTMATTER = ["name", "description"];

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** Split a note into frontmatter and body. */
export function parseNote(text: string): ParsedNote {
  const normalized = text.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    return { frontmatter: {}, body: normalized, hasFrontmatter: false, raw: "" };
  }
  return {
    frontmatter: parseFrontmatterBlock(match[1]),
    body: normalized.slice(match[0].length),
    hasFrontmatter: true,
    raw: match[0],
  };
}

function parseFrontmatterBlock(block: string): Frontmatter {
  const fm: Frontmatter = {};
  let currentKey: string | null = null;

  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const existing = fm[currentKey];
      const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
      list.push(unquote(listItem[1]));
      fm[currentKey] = list;
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    currentKey = key;
    const value = rawValue.trim();

    if (!value) {
      // Either an empty scalar or the header of a block list; list items on
      // following lines will replace this.
      fm[key] = "";
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s))
        .filter((s) => s.length > 0);
      continue;
    }
    fm[key] = unquote(value);
  }

  return fm;
}

function needsQuoting(value: string): boolean {
  return (
    value === "" ||
    /^[\s]|[\s]$/.test(value) ||
    /^[[{&*!|>%@`'"-]/.test(value) ||
    /:\s/.test(value) ||
    value.includes("\n") ||
    value.includes("#")
  );
}

function serializeScalar(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").trim();
  return needsQuoting(flat) ? `"${flat.replace(/"/g, '\\"')}"` : flat;
}

/**
 * Render frontmatter + body back into a note. `leadingKeys` is the fixed-order
 * prefix — OKF's four required keys for a note, `name`/`description` for a
 * skill manifest.
 */
export function serializeNote(
  frontmatter: Frontmatter,
  body: string,
  leadingKeys: readonly string[] = REQUIRED_FRONTMATTER
): string {
  const lines: string[] = ["---"];

  // Leading keys first, in the order given, then everything else alphabetically
  // — so a note Betty rewrites keeps a stable, diffable key order.
  const keys = [
    ...leadingKeys.filter((k) => k in frontmatter),
    ...Object.keys(frontmatter)
      .filter((k) => !leadingKeys.includes(k))
      .sort(),
  ];

  for (const key of keys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${serializeScalar(item)}`);
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  lines.push("---", "");

  return `${lines.join("\n")}\n${body.replace(/^\n+/, "")}`;
}

/**
 * Build frontmatter for a note Betty is creating. `timestamp` is passed in
 * rather than read from the clock here so callers (and tests) stay in control.
 */
export function buildFrontmatter(opts: {
  title: string;
  description?: string;
  type?: string;
  timestamp: string;
  extra?: Frontmatter;
}): Frontmatter {
  return {
    type: opts.type ?? "note",
    title: opts.title,
    description: opts.description ?? opts.title,
    timestamp: opts.timestamp,
    source: BETTY_SOURCE,
    ...opts.extra,
  };
}

/**
 * Build frontmatter for a `SKILL.md` Betty is creating. Deliberately not OKF:
 * a skill is loaded by `list_skills`, which wants `name` and `description`, and
 * would treat an OKF `title`/`type` block as a folder that isn't a skill at all.
 * `source` and `timestamp` ride along so Betty's own skills stay greppable.
 */
export function buildSkillFrontmatter(opts: {
  name: string;
  description: string;
  timestamp: string;
  extra?: Frontmatter;
}): Frontmatter {
  return {
    name: opts.name,
    description: opts.description,
    source: BETTY_SOURCE,
    timestamp: opts.timestamp,
    ...opts.extra,
  };
}

/** Report which required OKF keys a note is missing. */
export function missingRequiredKeys(frontmatter: Frontmatter): string[] {
  return REQUIRED_FRONTMATTER.filter((k) => {
    const v = frontmatter[k];
    return v === undefined || (typeof v === "string" && v.trim() === "");
  });
}

export interface Heading {
  level: number;
  text: string;
  /** Index of the heading line itself. */
  line: number;
}

/**
 * List ATX headings in a body, skipping anything inside a fenced code block —
 * otherwise a `# comment` in a shell snippet reads as a section.
 */
export function listHeadings(body: string): Heading[] {
  const lines = body.split(/\r?\n/);
  const headings: Heading[] = [];
  let fence: string | null = null;

  lines.forEach((line, i) => {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2].trim(), line: i });
    }
  });

  return headings;
}

function headingMatches(heading: Heading, wanted: string): boolean {
  const strip = (s: string) => s.replace(/^#+\s*/, "").trim().toLowerCase();
  return strip(heading.text) === strip(wanted);
}

export interface SectionRange {
  heading: Heading;
  /** First line of the section body (exclusive of the heading line). */
  bodyStart: number;
  /** One past the last line of the section body. */
  bodyEnd: number;
}

/**
 * Locate a section by heading text. The section runs from just after the
 * heading to the next heading of the same or higher level (or end of file) —
 * so replacing "## Notes" keeps its "### Detail" subsections with it.
 */
export function findSection(body: string, wanted: string): SectionRange | null {
  const headings = listHeadings(body);
  const lineCount = body.split(/\r?\n/).length;

  const index = headings.findIndex((h) => headingMatches(h, wanted));
  if (index === -1) return null;

  const heading = headings[index];
  const next = headings.slice(index + 1).find((h) => h.level <= heading.level);

  return {
    heading,
    bodyStart: heading.line + 1,
    bodyEnd: next ? next.line : lineCount,
  };
}

/** Replace the content under an existing heading, keeping the heading itself. */
export function replaceSection(body: string, wanted: string, content: string): string {
  const section = findSection(body, wanted);
  if (!section) {
    throw new Error(sectionNotFoundMessage(body, wanted));
  }
  const lines = body.split(/\r?\n/);
  const replacement = content.replace(/\s+$/, "").split(/\r?\n/);

  lines.splice(
    section.bodyStart,
    section.bodyEnd - section.bodyStart,
    "",
    ...replacement,
    ""
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Append content to the end of an existing section. */
export function appendToSection(body: string, wanted: string, content: string): string {
  const section = findSection(body, wanted);
  if (!section) {
    throw new Error(sectionNotFoundMessage(body, wanted));
  }
  const lines = body.split(/\r?\n/);
  const addition = content.replace(/\s+$/, "").split(/\r?\n/);

  // Step back over trailing blank lines so the addition sits directly under
  // the section's existing content rather than after a gap.
  let insertAt = section.bodyEnd;
  while (insertAt > section.bodyStart && lines[insertAt - 1].trim() === "") insertAt--;

  lines.splice(insertAt, 0, "", ...addition);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Error text that tells the model what headings *do* exist, so it can retry.
 *
 * Names no tool: memory and skills have separate append/replace tools, so any
 * name here would be wrong half the time. The advice is phrased as the action
 * instead, which is true for both.
 */
export function sectionNotFoundMessage(body: string, wanted: string): string {
  const available = listHeadings(body);
  if (available.length === 0) {
    return `No section titled "${wanted}" — this note has no headings at all. Append without a heading to add content.`;
  }
  const list = available.map((h) => `"${h.text}"`).join(", ");
  return `No section titled "${wanted}". Existing headings: ${list}. Replacing a section only rewrites a heading that already exists — append without a heading to add new content.`;
}

/** Append content to the end of a body. */
export function appendToBody(body: string, content: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const addition = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${addition}\n` : `${addition}\n`;
}

/** One line of change history for MEMORY_ROOT/log.md. */
export function logLine(timestamp: string, action: string, path: string, detail?: string): string {
  const suffix = detail ? ` — ${detail.replace(/\r?\n/g, " ").trim()}` : "";
  return `- ${timestamp} \`${action}\` [${path}](${path})${suffix}`;
}

/** Markdown links in an index.md entry, used for index-first search. */
export function extractLinks(body: string): Array<{ text: string; target: string }> {
  const links: Array<{ text: string; target: string }> = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    links.push({ text: m[1].trim(), target: m[2].trim() });
  }
  return links;
}
