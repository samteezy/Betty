/**
 * Path scoping for notes.
 *
 * Tool-facing paths are always POSIX-style and relative to NOTES_ROOT, so the
 * LLM never sees (or gets to supply) an absolute filesystem path or a DAV URL.
 * The same relative form works for both the local and WebDAV backends.
 *
 * Mirrors the guard used for attachment downloads in src/tools/register.ts —
 * normalize, then reject anything that escapes the root.
 */

export class NoteScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteScopeError";
  }
}

/** Collapse separators and resolve "." / ".." segments in a POSIX-ish path. */
function collapse(path: string): { segments: string[]; escaped: boolean } {
  const segments: string[] = [];
  let escaped = false;
  for (const raw of path.split(/[\\/]+/)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (segments.length === 0) escaped = true;
      else segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return { segments, escaped };
}

/**
 * Normalize a root as configured by the user. Keeps a leading slash when the
 * user supplied one (WebDAV roots are typically server-absolute, local roots
 * are filesystem-absolute) and always strips the trailing slash.
 */
export function normalizeRoot(root: string): string {
  const absolute = /^[\\/]/.test(root);
  const { segments, escaped } = collapse(root);
  if (escaped) {
    throw new NoteScopeError(`Root path escapes above its own base: ${root}`);
  }
  return (absolute ? "/" : "") + segments.join("/");
}

/**
 * Validate an LLM-supplied path and return it normalized, relative to the
 * notes root. Rejects absolute paths and any "../" that would climb out.
 */
export function safeRelPath(input: string, label = "path"): string {
  if (/^[a-zA-Z]+:\/\//.test(input)) {
    throw new NoteScopeError(`${label} must be a relative path, not a URL: ${input}`);
  }
  if (/^[\\/]/.test(input)) {
    throw new NoteScopeError(
      `${label} must be relative to the notes root, not absolute: ${input}`
    );
  }
  if (input.includes("\0")) {
    throw new NoteScopeError(`${label} contains an invalid character`);
  }
  const { segments, escaped } = collapse(input);
  if (escaped) {
    throw new NoteScopeError(`${label} escapes the notes root: ${input}`);
  }
  return segments.join("/");
}

/**
 * Express `child` relative to `parent`, or return null when child is not
 * inside parent. Both are normalized first, so this is a containment test on
 * whole path segments — "/notes/memory-old" is not inside "/notes/memory".
 */
export function relativeUnder(parent: string, child: string): string | null {
  const p = normalizeRoot(parent);
  const c = normalizeRoot(child);
  if (c === p) return "";
  if (!c.startsWith(p.endsWith("/") ? p : `${p}/`)) return null;
  return c.slice(p.length).replace(/^\/+/, "");
}

/**
 * Resolve a configured sub-root (MEMORY_ROOT, SKILLS_ROOT) into a prefix
 * relative to the notes root. Accepts either a full path under the notes root
 * or a path already relative to it, and fails loudly when it falls outside.
 */
export function resolveSubRoot(
  notesRoot: string,
  subRoot: string,
  varName: string
): string {
  const trimmed = subRoot.trim();
  if (!trimmed) {
    throw new NoteScopeError(`${varName} must not be empty`);
  }

  // Supplied as a full path (e.g. NOTES_ROOT=/notes, MEMORY_ROOT=/notes/memory)
  if (/^[\\/]/.test(trimmed) || relativeUnder(notesRoot, trimmed) !== null) {
    const rel = relativeUnder(notesRoot, trimmed);
    if (rel === null) {
      throw new NoteScopeError(
        `${varName} (${subRoot}) must be inside NOTES_ROOT (${notesRoot})`
      );
    }
    if (rel === "") {
      throw new NoteScopeError(
        `${varName} (${subRoot}) must be a subdirectory of NOTES_ROOT, not NOTES_ROOT itself`
      );
    }
    return rel;
  }

  // Supplied relative to the notes root (e.g. MEMORY_ROOT=memory)
  const rel = safeRelPath(trimmed, varName);
  if (!rel) {
    throw new NoteScopeError(
      `${varName} (${subRoot}) must be a subdirectory of NOTES_ROOT, not NOTES_ROOT itself`
    );
  }
  return rel;
}

/** True when `path` is at or below `prefix` (both relative to the notes root). */
export function isUnderPrefix(prefix: string, path: string): boolean {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The write guard. Reads may span the whole notes root — the user's entire
 * vault, if they point Betty at it. Writes must land inside one of Betty's own
 * roots: the memory root, plus the skills root when configured. Everything else
 * under NOTES_ROOT is the user's, and stays readable but untouchable.
 *
 * Enforced here, in code — never merely stated in a tool description, which a
 * model is free to ignore.
 *
 * An empty prefix is dropped rather than honoured: `isUnderPrefix("")` means
 * "unrestricted", which is the right answer for a search scope and exactly the
 * wrong one for a write scope.
 */
export function assertWritable(prefixes: readonly string[], relPath: string): void {
  const scopes = prefixes.filter((prefix) => prefix.length > 0);
  if (scopes.length === 0) {
    throw new NoteScopeError(
      `Refusing to write "${relPath}": no writable root is configured (set MEMORY_ROOT)`
    );
  }
  if (scopes.some((prefix) => isUnderPrefix(prefix, relPath))) return;

  const list = scopes.map((prefix) => `"${prefix}/"`).join(" or ");
  throw new NoteScopeError(
    `Refusing to write outside Betty's own roots: "${relPath}" is not under ${list} ` +
      `(set MEMORY_ROOT or SKILLS_ROOT to change where Betty may write)`
  );
}

/** Join a root with a relative path for backend consumption. */
export function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  return `${root.replace(/\/+$/, "")}/${rel}`;
}
