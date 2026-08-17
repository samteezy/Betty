/**
 * Breadth-first traversal of a notes tree.
 *
 * WebDAV has no server-side recursive listing worth relying on and no grep at
 * all, so a traversal is one PROPFIND per directory. Every walk is therefore
 * bounded, and reports whether it hit a bound — a search that silently stopped
 * early reads as "nothing more to find", which is the wrong answer.
 */

import { NoteEntry, NotesBackend } from "../types.js";

export interface WalkOptions {
  maxDirectories?: number;
  maxDepth?: number;
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
