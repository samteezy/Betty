/**
 * Notes backend over the local filesystem.
 *
 * ETags are synthesized from mtime + size. That's weaker than a server-issued
 * ETag — two writes inside the same millisecond that produce the same length
 * are indistinguishable — but it catches the case that actually matters: a
 * human editing the file in Obsidian while Betty holds a stale copy.
 */

import {
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NoteEntry, NoteRead, NotesBackend, NoteWriteResult } from "../types.js";
import { NoteConflictError, NoteNotFoundError, conflictMessage, existsMessage } from "./errors.js";

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function etagFor(mtimeMs: number, size: number): string {
  return `W/"${Math.floor(mtimeMs)}-${size}"`;
}

/**
 * Do two different paths name the same file? True only on a case-insensitive
 * filesystem doing a case-only rename, which is the one situation where
 * "the destination already exists" is the wrong answer.
 */
async function isSameFile(src: string, dst: string, srcInfo: Stats): Promise<boolean> {
  if (src === dst) return true;
  try {
    const dstInfo = await stat(dst);
    return dstInfo.ino === srcInfo.ino && dstInfo.dev === srcInfo.dev;
  } catch {
    return false;
  }
}

export class LocalNotesBackend implements NotesBackend {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async connect(): Promise<void> {
    try {
      const info = await stat(this.root);
      if (!info.isDirectory()) {
        throw new Error(`NOTES_ROOT is not a directory: ${this.root}`);
      }
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        throw new Error(`NOTES_ROOT does not exist: ${this.root}`);
      }
      throw err;
    }
  }

  /**
   * Map a root-relative POSIX path to an absolute one, re-checking containment
   * after resolution. The tool layer has already validated the path; this is
   * the belt to that braces.
   */
  private absolute(relPath: string): string {
    const abs = resolve(join(this.root, ...relPath.split("/").filter(Boolean)));
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || (rel !== "" && resolve(this.root, rel) !== abs)) {
      throw new Error(`Path escapes NOTES_ROOT: ${relPath}`);
    }
    return abs;
  }

  async list(dir: string): Promise<NoteEntry[]> {
    const abs = this.absolute(dir);
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) return [];
      throw err;
    }

    const entries: NoteEntry[] = [];
    for (const dirent of dirents) {
      // Dot-prefixed paths are skipped: Obsidian ignores them entirely, so
      // anything hidden here would be invisible to the user in their own vault.
      if (dirent.name.startsWith(".")) continue;

      const childRel = dir ? `${dir}/${dirent.name}` : dirent.name;
      const isDirectory = dirent.isDirectory();
      const entry: NoteEntry = { path: childRel, name: dirent.name, isDirectory };

      if (!isDirectory) {
        try {
          const info = await stat(join(abs, dirent.name));
          entry.size = info.size;
          entry.modified = new Date(info.mtimeMs).toISOString();
          entry.etag = etagFor(info.mtimeMs, info.size);
        } catch (err) {
          // Vanished between readdir and stat — skip rather than fail the listing.
          if (!isErrno(err, "ENOENT")) throw err;
          continue;
        }
      }
      entries.push(entry);
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string): Promise<NoteRead> {
    const abs = this.absolute(path);
    let handle;
    try {
      handle = await open(abs, "r");
    } catch (err) {
      if (isErrno(err, "ENOENT") || isErrno(err, "EISDIR")) throw new NoteNotFoundError(path);
      throw err;
    }
    try {
      // stat and read through the same handle so the etag describes the bytes
      // actually returned.
      const info = await handle.stat();
      if (info.isDirectory()) throw new NoteNotFoundError(path);
      const text = await handle.readFile("utf8");
      return { text, etag: etagFor(info.mtimeMs, info.size) };
    } finally {
      await handle.close();
    }
  }

  async write(path: string, text: string, ifMatch?: string): Promise<NoteWriteResult> {
    const abs = this.absolute(path);
    await mkdir(dirname(abs), { recursive: true });

    if (ifMatch === undefined) {
      // Create-only. The "wx" flag makes the existence check atomic — the same
      // guarantee the attachment saver relies on.
      try {
        await writeFile(abs, text, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if (isErrno(err, "EEXIST")) throw new NoteConflictError(existsMessage(path));
        throw err;
      }
      const info = await stat(abs);
      return { etag: etagFor(info.mtimeMs, info.size) };
    }

    let current;
    try {
      current = await stat(abs);
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new NoteNotFoundError(path);
      throw err;
    }
    if (etagFor(current.mtimeMs, current.size) !== ifMatch) {
      throw new NoteConflictError(conflictMessage(path));
    }

    // Write to a sibling temp file and rename, so a crash mid-write can't
    // truncate the user's note.
    const temp = join(dirname(abs), `.betty-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, "utf8");
      await rename(temp, abs);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }

    const info = await stat(abs);
    return { etag: etagFor(info.mtimeMs, info.size) };
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.absolute(from);
    const dst = this.absolute(to);
    if (src === dst) throw new NoteConflictError(existsMessage(to));

    let info;
    try {
      info = await stat(src);
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new NoteNotFoundError(from);
      throw err;
    }
    // read() treats a directory as not-found; a move must tell the same story
    // rather than relocating a whole folder because one was sitting there.
    if (info.isDirectory()) throw new NoteNotFoundError(from);

    await mkdir(dirname(dst), { recursive: true });

    // On a case-insensitive filesystem (APFS, NTFS) a case-only rename points
    // at the same inode, so the placeholder below would collide with the file
    // being moved and report that the destination "already exists". rename()
    // handles this case correctly on its own, and cannot lose anything here
    // because both paths are the same file.
    if (await isSameFile(src, dst, info)) {
      await rename(src, dst);
      return;
    }

    // rename(2) silently replaces an existing destination, and a stat-then-
    // rename is both racy and exactly the unconditional overwrite this project
    // doesn't have. Claim the destination with an exclusive create first — the
    // same atomic existence check write() gets from flag:"wx" — so the gap
    // between checking and renaming can't be used to lose a file.
    try {
      const placeholder = await open(dst, "wx");
      await placeholder.close();
    } catch (err) {
      if (isErrno(err, "EEXIST")) throw new NoteConflictError(existsMessage(to));
      throw err;
    }

    try {
      await rename(src, dst);
    } catch (err) {
      if (isErrno(err, "EXDEV")) {
        // NOTES_ROOT spanning a mount point. The placeholder is ours, so
        // overwriting it here is not overwriting anyone's note — but a failed
        // copy must still clear it, or the half-written file would make every
        // retry of this move report a conflict forever, with no delete tool to
        // clean it up.
        try {
          await copyFile(src, dst);
        } catch (copyErr) {
          await unlink(dst).catch(() => undefined);
          throw copyErr;
        }
        await unlink(src);
        return;
      }
      await unlink(dst).catch(() => undefined);
      throw err;
    }
  }
}
