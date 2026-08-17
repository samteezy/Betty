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

  async write(path: string, text: string, ifMatch?: string): Promise<NoteWriteResult> {
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
