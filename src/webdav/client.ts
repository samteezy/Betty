/**
 * WebDAV HTTP client for PROPFIND and REPORT requests.
 * Uses native fetch() — no external dependencies.
 */

import { parseMultistatus, DavResponseEntry } from "./xml.js";

export interface WebDavConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export class WebDavError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`WebDAV error [${status}]: ${message}`);
    this.name = "WebDavError";
  }
}

export class WebDavClient {
  private config: WebDavConfig;

  constructor(config: WebDavConfig) {
    // Normalize baseUrl: strip trailing slash
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    };
  }

  async propfind(
    path: string,
    body: string,
    depth: "0" | "1" = "1"
  ): Promise<DavResponseEntry[]> {
    const xml = await this.request("PROPFIND", path, body, {
      Depth: depth,
    });
    return parseMultistatus(xml);
  }

  async report(path: string, body: string): Promise<DavResponseEntry[]> {
    const xml = await this.request("REPORT", path, body, {
      Depth: "1",
    });
    return parseMultistatus(xml);
  }

  async get(path: string): Promise<string> {
    return this.request("GET", path, undefined);
  }

  async put(
    path: string,
    body: string,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    return this.request("PUT", path, body, {
      "Content-Type": "text/calendar; charset=utf-8",
      ...extraHeaders,
    });
  }

  /**
   * GET a resource along with its ETag, for callers that intend to write it
   * back under an If-Match precondition.
   */
  async getWithEtag(
    path: string,
    extraHeaders?: Record<string, string>
  ): Promise<{ body: string; etag?: string }> {
    const res = await this.requestRaw("GET", path, undefined, extraHeaders);
    return { body: res.body, etag: res.headers.get("etag") ?? undefined };
  }

  /**
   * PUT a resource and return the ETag the server assigned. Servers are not
   * required to echo one back, so a follow-up read may be needed to learn it.
   */
  async putWithEtag(
    path: string,
    body: string,
    extraHeaders?: Record<string, string>
  ): Promise<{ etag?: string }> {
    const res = await this.requestRaw("PUT", path, body, {
      "Content-Type": "text/calendar; charset=utf-8",
      ...extraHeaders,
    });
    return { etag: res.headers.get("etag") ?? undefined };
  }

  async delete(path: string, ifMatch?: string): Promise<void> {
    await this.request(
      "DELETE",
      path,
      undefined,
      ifMatch ? { "If-Match": ifMatch } : undefined
    );
  }

  /**
   * Create a collection. Resolves silently when the collection already exists
   * (405 Method Not Allowed), so callers can make parent directories
   * idempotently.
   */
  async mkcol(path: string): Promise<void> {
    try {
      await this.request("MKCOL", path, undefined);
    } catch (err) {
      if (err instanceof WebDavError && err.status === 405) return;
      throw err;
    }
  }

  private async request(
    method: string,
    path: string,
    body: string | undefined,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const res = await this.requestRaw(method, path, body, extraHeaders);
    return res.body;
  }

  private async requestRaw(
    method: string,
    path: string,
    body: string | undefined,
    extraHeaders?: Record<string, string>
  ): Promise<{ body: string; headers: Headers; status: number }> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      ...extraHeaders,
    };
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/xml; charset=utf-8";
    }

    let res = await fetch(url, { method, headers, body, redirect: "manual" });

    // Follow redirects manually to preserve method and body (fetch may
    // drop the body on automatic redirects for non-GET methods)
    let redirects = 0;
    while (
      redirects < 5 &&
      (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308)
    ) {
      const location = res.headers.get("location");
      if (!location) break;
      const redirectUrl = new URL(location, url).href;
      // SSRF check: ensure redirect stays on same origin
      if (new URL(redirectUrl).origin !== new URL(url).origin) {
        throw new Error(`Refusing redirect to foreign origin: ${redirectUrl}`);
      }
      res = await fetch(redirectUrl, { method, headers, body, redirect: "manual" });
      redirects++;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebDavError(
        res.status,
        `${method} ${url} failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
      );
    }

    return { body: await res.text(), headers: res.headers, status: res.status };
  }

  private buildUrl(path: string): string {
    const baseOrigin = new URL(this.config.baseUrl).origin;
    let url: string;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      url = path;
    } else if (path.startsWith("/")) {
      url = `${baseOrigin}${path}`;
    } else {
      url = `${this.config.baseUrl}/${path}`;
    }
    // Prevent SSRF: never send credentials to a foreign origin
    if (new URL(url).origin !== baseOrigin) {
      throw new Error(`Refusing request to foreign origin: ${url}`);
    }
    return url;
  }

  private authHeader(): string {
    const credentials = `${this.config.username}:${this.config.password}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
}
