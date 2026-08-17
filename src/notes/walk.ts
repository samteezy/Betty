/**
 * Breadth-first traversal of a notes tree.
 *
 * WebDAV has no server-side recursive listing worth relying on and no grep at
 * all, so a traversal is one PROPFIND per directory. Every walk is therefore
 * bounded, and reports whether it hit a bound — a search that silently stopped
 * early reads as "nothing more to find", which is the wrong answer.
 */

import { NoteEntry, NotesBackend } from "../types.js";
import { isUnderPrefix } from "./paths.js";

export interface WalkOptions {
  maxDirectories?: number;
  maxDepth?: number;
  /**
   * Directories to skip, relative to the notes root. Pruned at the queue, so
   * their contents are never listed at all — each directory is one PROPFIND on
   * WebDAV and counts against maxDirectories, so filtering the results instead
   * would let a fat trash folder push a search of live memory into `truncated`.
   *
   * An exclusion at or above the walk root is ignored: walking Betty's trash
   * explicitly means you want to see it.
   *
   * Pruning never sets `truncated`. Truncation means "a bound was hit and there
   * is more to find inside the scope you asked for"; an excluded directory is
   * outside that scope by definition.
   */
  exclude?: readonly string[];
}

export interface WalkResult {
  files: NoteEntry[];
  directories: string[];
  /** True when a bound was hit and the tree was not fully explored. */
  truncated: boolean;
}

export const DEFAULT_MAX_DIRECTORIES = 200;
export const DEFAULT_MAX_DEPTH = 8;

export async function walkNotes(
  backend: NotesBackend,
  root: string,
  options: WalkOptions = {}
): Promise<WalkResult> {
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  // Drop exclusions sitting at or above the root, so an explicitly scoped walk
  // into an excluded directory still returns its contents.
  const exclude = (options.exclude ?? []).filter((p) => p && !isUnderPrefix(p, root));

  const files: NoteEntry[] = [];
  const directories: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const seen = new Set<string>([root]);
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (visited >= maxDirectories) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (!current) break;
    visited++;

    const entries = await backend.list(current.path);
    for (const entry of entries) {
      if (entry.isDirectory) {
        // Absent from `directories` too — that list reports what the walk
        // found, and naming one it deliberately never entered would mislead.
        if (exclude.some((p) => isUnderPrefix(p, entry.path))) continue;
        directories.push(entry.path);
        if (current.depth + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        if (!seen.has(entry.path)) {
          seen.add(entry.path);
          queue.push({ path: entry.path, depth: current.depth + 1 });
        }
      } else {
        files.push(entry);
      }
    }
  }

  return { files, directories, truncated };
}

/** Markdown files only — Betty's notes and skills are always markdown. */
export function isMarkdown(entry: NoteEntry): boolean {
  return !entry.isDirectory && /\.mdx?$/i.test(entry.name);
}
