/**
 * Notes backend over WebDAV — PROPFIND to list, GET to read, PUT to write.
 *
 * Shares the WebDAV transport with CalDAV and CardDAV, so there is one auth
 * path and one set of SSRF guards for the whole server.
 *
 * Unlike the CalDAV writers, every update here carries a real `If-Match:
 * "<etag>"` rather than the `If-Match: "*"` wildcard. The wildcard only
 * asserts that the resource exists; it will happily overwrite a note the user
 * edited in Obsidian thirty seconds ago.
 *
 * That header is necessary but, on real servers, not sufficient. **Fastmail
 * Files — the setup this project documents first — accepts a PUT carrying a
 * stale `If-Match`, a syntactically bogus one, or `If-None-Match: *` against a
 * file that already exists.** Verified against the live service: all three are
 * discarded. A client that trusted the header alone would silently clobber a
 * concurrent human edit on the very backend most users run.
 *
 * So every conditional write is preceded by a PROPFIND that compares the
 * current ETag itself, and every create by one that checks for existence. This
 * costs one extra round trip per write and does not close the race — another
 * writer can still land in the gap between PROPFIND and PUT — but it turns
 * "silently overwrites your edit" into "almost always refuses", which is the
 * difference between a promise that mostly holds and one that never does. The
 * headers are still sent, so servers that do enforce them keep the atomic
 * guarantee.
 */

import { WebDavClient, WebDavError } from "../webdav/client.js";
import { hasElement } from "../webdav/xml.js";
import { NoteEntry, NoteRead, NotesBackend, NoteWriteResult } from "../types.js";
import { NoteConflictError, NoteNotFoundError, conflictMessage, existsMessage } from "./errors.js";
import { joinPath } from "./paths.js";

const PROPFIND_ENTRIES = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export class WebDavNotesBackend implements NotesBackend {
  private readonly client: WebDavClient;
  private readonly root: string;
  private readonly rootPath: string;

  constructor(client: WebDavClient, opts: { baseUrl: string; root: string }) {
    this.client = client;
    this.root = opts.root;

    // Resolve the configured root to a server-absolute path once, so hrefs
    // coming back from PROPFIND can be mapped to root-relative paths.
    const base = opts.baseUrl.replace(/\/+$/, "");
    const absolute = /^[/]/.test(opts.root)
      ? new URL(opts.root, base).href
      : `${base}/${opts.root}`;
    this.rootPath = decodeURIComponent(new URL(absolute).pathname).replace(/\/+$/, "");
  }

  async connect(): Promise<void> {
    try {
      await this.client.propfind(this.root, PROPFIND_ENTRIES, "0");
    } catch (err) {
      if (err instanceof WebDavError && err.status === 404) {
        throw new Error(
          `NOTES_ROOT not found on the WebDAV server: ${this.root}. ` +
            `Check WEBDAV_URL and NOTES_ROOT — for Fastmail this is typically ` +
            `WEBDAV_URL=https://myfiles.fastmail.com and NOTES_ROOT=/<username>/Notes`
        );
      }
      throw err;
    }
  }

  /** Map a server href back to a path relative to the notes root. */
  private toRelative(href: string): string | null {
    let path: string;
    try {
      path = decodeURIComponent(new URL(href, "http://placeholder.invalid").pathname);
    } catch {
      return null;
    }
    path = path.replace(/\/+$/, "");
    if (path === this.rootPath) return "";
    if (!path.startsWith(`${this.rootPath}/`)) return null;
    return path.slice(this.rootPath.length + 1);
  }

  async list(dir: string): Promise<NoteEntry[]> {
    let responses;
    try {
      responses = await this.client.propfind(joinPath(this.root, dir), PROPFIND_ENTRIES, "1");
    } catch (err) {
      if (err instanceof WebDavError && (err.status === 404 || err.status === 403)) return [];
      throw err;
    }

    const entries: NoteEntry[] = [];
    for (const response of responses) {
      const relPath = this.toRelative(response.href);
      // Depth 1 includes the collection itself — skip it and anything outside.
      if (relPath === null || relPath === "" || relPath === dir) continue;

      const name = relPath.split("/").pop() ?? relPath;
      if (name.startsWith(".")) continue;

      const isDirectory = hasElement(response.props.get("resourcetype") ?? "", "collection");
      const entry: NoteEntry = { path: relPath, name, isDirectory };

      if (!isDirectory) {
        const etag = response.props.get("getetag");
        const length = response.props.get("getcontentlength");
        const modified = response.props.get("getlastmodified");
        if (etag) entry.etag = etag;
        if (length && /^\d+$/.test(length)) entry.size = parseInt(length, 10);
        if (modified) {
          const parsed = new Date(modified);
          if (!isNaN(parsed.getTime())) entry.modified = parsed.toISOString();
        }
      }
      entries.push(entry);
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string): Promise<NoteRead> {
    try {
      const { body, etag } = await this.client.getWithEtag(joinPath(this.root, path));
      return { text: body, etag };
    } catch (err) {
      if (err instanceof WebDavError && err.status === 404) {
        throw new NoteNotFoundError(path);
      }
      throw err;
    }
  }

  /**
   * Enforce the precondition client-side, because the server may not.
   * See the file header: Fastmail Files discards If-Match and If-None-Match.
   */
  private async checkPrecondition(path: string, ifMatch?: string): Promise<void> {
    if (ifMatch === undefined) {
      // Create-only. Ask about existence directly: a server that returns no
      // ETag would otherwise read as "nothing there" and permit an overwrite.
      if (await this.existsAt(path)) throw new NoteConflictError(existsMessage(path));
      return;
    }

    // An unreadable ETag means the file is gone, or the server won't say.
    // Neither is grounds for refusing a write the caller holds an ETag for —
    // let the PUT and its If-Match have the final word.
    const current = await this.etagOf(path);
    if (current !== undefined && current !== ifMatch) {
      throw new NoteConflictError(conflictMessage(path));
    }
  }

  /** Does anything exist at this path? Depth-0 PROPFIND, 404 means no. */
  private async existsAt(path: string): Promise<boolean> {
    try {
      const responses = await this.client.propfind(
        joinPath(this.root, path),
        PROPFIND_ENTRIES,
        "0"
      );
      return responses.length > 0;
    } catch (err) {
      if (err instanceof WebDavError && (err.status === 404 || err.status === 403)) return false;
      // Any other failure is not evidence of absence. Say nothing is there and
      // let If-None-Match have the final word rather than blocking the write.
      return false;
    }
  }

  async write(path: string, text: string, ifMatch?: string): Promise<NoteWriteResult> {
    await this.checkPrecondition(path, ifMatch);
    const target = joinPath(this.root, path);
    // If-None-Match "*" is a genuine create-only precondition; If-Match with a
    // real etag is genuine optimistic concurrency. Neither is a wildcard write.
    const headers: Record<string, string> = {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      ...(ifMatch === undefined ? { "If-None-Match": "*" } : { "If-Match": ifMatch }),
    };

    let result;
    try {
      result = await this.client.putWithEtag(target, text, headers);
    } catch (err) {
      if (err instanceof WebDavError && err.status === 409 && ifMatch === undefined) {
        // 409 on create means the parent collection doesn't exist yet.
        await this.ensureParents(path);
        result = await this.client.putWithEtag(target, text, headers).catch((retryErr) => {
          throw this.translate(retryErr, path, ifMatch);
        });
        return { etag: result.etag ?? (await this.etagOf(path)) };
      }
      throw this.translate(err, path, ifMatch);
    }

    // Servers aren't obliged to return an ETag on PUT; fetch one so the caller
    // can chain another conditional write without a full re-read.
    return { etag: result.etag ?? (await this.etagOf(path)) };
  }

  async move(from: string, to: string): Promise<void> {
    const src = joinPath(this.root, from);
    const dst = joinPath(this.root, to);
    try {
      await this.client.move(src, dst);
    } catch (err) {
      if (err instanceof WebDavError && err.status === 409) {
        // 409 on MOVE means the destination's parent collection is missing —
        // the trash folder, the first time anything is retired into it.
        await this.ensureParents(to);
        await this.client.move(src, dst).catch((retryErr) => {
          throw this.translateMove(retryErr, from, to);
        });
        return;
      }
      throw this.translateMove(err, from, to);
    }
  }

  private translateMove(err: unknown, from: string, to: string): unknown {
    if (err instanceof WebDavError) {
      // RFC 4918 §9.9.4: Overwrite "F" against a non-null destination is a 412.
      if (err.status === 412) return new NoteConflictError(existsMessage(to));
      if (err.status === 404) return new NoteNotFoundError(from);
      if (err.status === 409) {
        return new Error(
          `Could not move "${from}" to "${to}": the parent folder could not be created on the server.`
        );
      }
    }
    // 403 (server refuses), 423 (locked), and 507 (quota) are not conflicts and
    // must not be dressed up as one — telling the model to retry under another
    // name cannot fix a permission or quota failure.
    return err;
  }

  private translate(err: unknown, path: string, ifMatch?: string): unknown {
    if (err instanceof WebDavError) {
      if (err.status === 412) {
        return new NoteConflictError(
          ifMatch === undefined ? existsMessage(path) : conflictMessage(path)
        );
      }
      if (err.status === 404 && ifMatch !== undefined) {
        return new NoteNotFoundError(path);
      }
    }
    return err;
  }

  /** Create any missing parent collections, top-down. */
  private async ensureParents(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    segments.pop(); // drop the filename
    let cumulative = "";
    for (const segment of segments) {
      cumulative = cumulative ? `${cumulative}/${segment}` : segment;
      await this.client.mkcol(joinPath(this.root, cumulative));
    }
  }

  /** Read just the ETag of a resource, without transferring its body. */
  private async etagOf(path: string): Promise<string | undefined> {
    try {
      const responses = await this.client.propfind(
        joinPath(this.root, path),
        PROPFIND_ENTRIES,
        "0"
      );
      return responses[0]?.props.get("getetag") ?? undefined;
    } catch {
      // Not worth failing a successful write over — the caller just has to
      // re-read before its next conditional write.
      return undefined;
    }
  }
}
