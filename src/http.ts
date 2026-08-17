/**
 * Remote transport — Betty over Streamable HTTP.
 *
 * Stdio is still the default and is untouched: this exists for the one case it
 * cannot serve, which is reaching Betty from a phone. Run her on a machine at
 * home, put a tunnel in front of the port, and the same memory and skills are
 * there from a mobile client as from the laptop.
 *
 * Three decisions worth knowing about:
 *
 * 1. **A session is a connection.** The wake gate is per-connection by design —
 *    it arms at build time and re-arms after idle — so every HTTP session gets
 *    its own `buildServer()`, its own backends, and its own gate. Sharing one
 *    server across sessions would mean one phone waking Betty for the laptop.
 *    Sessions are reaped on DELETE, on transport close, and after
 *    `BETTY_HTTP_SESSION_TIMEOUT_MINUTES` of quiet, because a mobile client that
 *    loses signal never sends the DELETE.
 *
 * 2. **The token is checked before anything else runs.** Betty holds mail and
 *    memory, so an unauthenticated request never reaches the MCP layer. It is
 *    accepted two ways: `Authorization: Bearer <token>`, and as the last segment
 *    of the URL path (`/mcp/<token>`). The header is the right way and what
 *    header-capable clients should use; the path form exists because the
 *    connector UIs that matter for mobile take a URL and nothing else.
 *
 * 3. **Browsers are shut out unless invited.** Any request carrying an `Origin`
 *    is refused unless that origin is in `BETTY_HTTP_ALLOWED_ORIGINS`, which is
 *    empty by default. Native MCP clients don't send one; a page trying to
 *    reach a localhost bind does. That is DNS-rebinding protection, done here
 *    rather than through the SDK options of the same name, which are deprecated.
 *
 * No new dependencies: Node's own `http` module, the same way the IMAP and
 * WebDAV clients are built out of `net`/`tls`/`fetch`.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Backends, buildServer, connectAll, disconnectAll } from "./server.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_HTTP_PATH = "/mcp";
export const DEFAULT_MAX_SESSIONS = 8;
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 60;

/** Liveness probe for tunnels, Docker healthchecks, and "is it up?". */
export const HEALTH_PATH = "/health";

/**
 * Shortest token accepted. Not a strength estimate — it is long enough that a
 * hand-typed word fails the check and the user goes and generates one.
 */
export const MIN_TOKEN_LENGTH = 16;

/** Largest request body accepted, before the JSON is even parsed. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How often idle sessions are swept. */
export const REAP_INTERVAL_MS = 60_000;

export interface HttpConfig {
  /** Interface to bind. Defaults to loopback — put a tunnel in front. */
  host: string;
  port: number;
  /** Path the MCP endpoint answers on, without a trailing slash. */
  path: string;
  token: string;
  /** Origins allowed to talk to Betty from a browser. Empty means none. */
  allowedOrigins: string[];
  /** Accepted `Host` header values. Empty means any. */
  allowedHosts: string[];
  maxSessions: number;
  sessionTimeoutMs: number;
}

/**
 * Whether to serve HTTP rather than stdio.
 *
 * `BETTY_TRANSPORT=http` says so outright; setting `BETTY_HTTP_PORT` says it by
 * implication, since there is nothing else a port could be for. Everything else
 * — including the whole existing world of stdio configs — is stdio.
 */
export function httpEnabled(env: NodeJS.ProcessEnv): boolean {
  const transport = env.BETTY_TRANSPORT?.trim().toLowerCase();
  if (transport === "http") return true;
  if (transport === "stdio") return false;
  if (transport) {
    throw new Error(`Unknown BETTY_TRANSPORT: ${env.BETTY_TRANSPORT} (expected "stdio" or "http")`);
  }
  return Boolean(env.BETTY_HTTP_PORT?.trim());
}

/** Read and validate the HTTP settings. Throws on anything malformed. */
export function parseHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const token = env.BETTY_HTTP_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error(
      "BETTY_HTTP_TOKEN is required when serving over HTTP — Betty reaches your mail and " +
        "memory, so the endpoint is never left open. Generate one with: openssl rand -hex 32"
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `BETTY_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. ` +
        "Generate one with: openssl rand -hex 32"
    );
  }

  return {
    host: env.BETTY_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST,
    port: parsePort(env.BETTY_HTTP_PORT),
    path: parsePath(env.BETTY_HTTP_PATH),
    token,
    allowedOrigins: parseList(env.BETTY_HTTP_ALLOWED_ORIGINS),
    allowedHosts: parseList(env.BETTY_HTTP_ALLOWED_HOSTS),
    maxSessions: parseCount(env.BETTY_HTTP_MAX_SESSIONS, DEFAULT_MAX_SESSIONS, "BETTY_HTTP_MAX_SESSIONS"),
    sessionTimeoutMs:
      parseCount(
        env.BETTY_HTTP_SESSION_TIMEOUT_MINUTES,
        DEFAULT_SESSION_TIMEOUT_MINUTES,
        "BETTY_HTTP_SESSION_TIMEOUT_MINUTES"
      ) * 60_000,
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`BETTY_HTTP_PORT must be a port number 0-65535 (got "${raw}")`);
  }
  return port;
}

/**
 * Normalize the endpoint path. A trailing slash is dropped so the routing below
 * has one shape to match, and `/` itself is refused — the token can arrive as a
 * path segment, and a root endpoint would make every URL look like one.
 */
function parsePath(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_HTTP_PATH;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  const path = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (path === "/" || path === "") {
    throw new Error('BETTY_HTTP_PATH must name a path below the root, such as "/mcp"');
  }
  if (path === HEALTH_PATH) {
    throw new Error(`BETTY_HTTP_PATH must not be "${HEALTH_PATH}" — that is the health endpoint`);
  }
  return path;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCount(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}")`);
  }
  return value;
}

/** One live MCP session: a client connection, with everything it owns. */
interface Session {
  id: string | undefined;
  server: McpServer;
  backends: Backends;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  closing: boolean;
}

export interface HttpHostOptions {
  /** Overrides the config parsed from the environment. Tests pass port 0. */
  config?: HttpConfig;
  /** Where operational lines go. Defaults to stderr, as stdio mode does. */
  log?: (message: string) => void;
  /** Injectable clock, so the idle reaper can be tested without waiting. */
  now?: () => number;
}

export interface HttpHost {
  /** Bind and start serving. Resolves with the address actually bound. */
  listen(): Promise<{ host: string; port: number }>;
  /** Stop serving and close every open session. */
  close(): Promise<void>;
  readonly config: HttpConfig;
  /** Live session count, for tests and the reaper. */
  readonly sessionCount: number;
}

/**
 * Build the HTTP host. Nothing binds or connects until {@link HttpHost.listen}.
 */
export function createHttpHost(env: NodeJS.ProcessEnv, options: HttpHostOptions = {}): HttpHost {
  const config = options.config ?? parseHttpConfig(env);
  const log = options.log ?? ((message: string) => process.stderr.write(`betty-mcp: ${message}\n`));
  const now = options.now ?? Date.now;

  const sessions = new Map<string, Session>();
  const pending = new Set<Session>();
  let reaper: ReturnType<typeof setInterval> | undefined;

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Origin and Host first: a request Betty should not be talking to at all is
    // refused before its credentials are even looked at.
    const origin = header(req, "origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      sendError(res, 403, -32600, "Origin not allowed");
      return;
    }
    if (config.allowedHosts.length > 0) {
      const host = header(req, "host");
      if (!host || !config.allowedHosts.includes(host)) {
        sendError(res, 403, -32600, "Host not allowed");
        return;
      }
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }

    const route = routeFor(url.pathname, config);

    if (req.method === "OPTIONS") {
      // Only reachable when the origin passed the check above.
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (route.kind === "health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, -32600, "Method not allowed");
        return;
      }
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (route.kind === "none") {
      sendError(res, 404, -32600, "Not found");
      return;
    }

    if (!authorized(req, route.token, config.token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="betty-mcp"');
      sendError(res, 401, -32001, "Unauthorized");
      return;
    }

    const sessionId = header(req, "mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendError(res, 404, -32001, "Unknown or expired session — reinitialize");
        return;
      }
      session.lastSeen = now();
      const body = req.method === "POST" ? await parseBody(req, res) : undefined;
      if (body === PARSE_FAILED) return;
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session header: the only thing this can legitimately be is a fresh
    // `initialize`. Everything else is a client talking to a Betty that has
    // since restarted, and is better told so than handed a new session.
    if (req.method !== "POST") {
      sendError(res, 400, -32000, "Missing Mcp-Session-Id header");
      return;
    }
    const body = await parseBody(req, res);
    if (body === PARSE_FAILED) return;
    if (!isInitialize(body)) {
      sendError(res, 400, -32000, "Missing Mcp-Session-Id header");
      return;
    }

    reap();
    if (sessions.size + pending.size >= config.maxSessions) {
      sendError(res, 503, -32000, `Too many open sessions (limit ${config.maxSessions})`);
      return;
    }

    await openSession(req, res, body);
  }

  /**
   * Stand up a whole Betty for this client, then let her answer the initialize.
   *
   * `buildServer` is what arms the gate, so it has to be per session; a failure
   * here (unreachable notes root, say) is this client's problem and not the
   * process's, so it becomes a 500 rather than an exit.
   */
  async function openSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ): Promise<void> {
    let session: Session;
    try {
      session = await startSession();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`could not open a session: ${reason}`);
      sendError(res, 500, -32603, `Betty could not start a session: ${reason}`);
      return;
    }
    await session.transport.handleRequest(req, res, body);
  }

  /**
   * Build one Betty and connect her to a fresh transport. Anything that fails
   * on the way takes the half-built session down with it, rather than leaving a
   * mail connection and a gate timer with no client attached.
   */
  async function startSession(): Promise<Session> {
    const { server, backends } = buildServer(env);
    // Declared before the transport so its callbacks can reach the session, and
    // assigned immediately after — nothing can fire in between.
    let session: Session | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (!session) return;
        session.id = id;
        pending.delete(session);
        sessions.set(id, session);
        log(`session ${id} opened (${sessions.size} open)`);
      },
      onsessionclosed: (id) => {
        void closeSession(sessions.get(id));
      },
    });
    session = {
      id: undefined,
      server,
      backends,
      transport,
      lastSeen: now(),
      closing: false,
    };
    const opened = session;
    pending.add(opened);
    transport.onclose = () => void closeSession(opened);
    try {
      await connectAll(backends);
      await server.connect(transport);
    } catch (err) {
      await closeSession(opened);
      throw err;
    }
    return opened;
  }

  /** Close one session and release everything it holds. Idempotent. */
  async function closeSession(session: Session | undefined): Promise<void> {
    if (!session || session.closing) return;
    session.closing = true;
    pending.delete(session);
    if (session.id) sessions.delete(session.id);
    try {
      await session.transport.close();
      await session.server.close();
      await disconnectAll(session.backends);
    } catch (err) {
      log(`error closing session: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (session.id) log(`session ${session.id} closed (${sessions.size} open)`);
  }

  /**
   * Drop sessions nothing has touched for the timeout. A phone that walks out
   * of wifi never sends the DELETE, and each session holds a mail connection.
   *
   * A client holding its SSE stream open is not idle: every request stamps the
   * session, the standalone GET included, so this only reaches connections that
   * went away without saying so.
   */
  function reap(): void {
    const cutoff = now() - config.sessionTimeoutMs;
    for (const session of [...sessions.values()]) {
      if (session.lastSeen <= cutoff) void closeSession(session);
    }
  }

  return {
    config,
    get sessionCount() {
      return sessions.size;
    },

    async listen() {
      // Fail fast on a misconfigured Betty, exactly as stdio does: registerAll
      // is I/O-free, so this validates the whole environment without touching
      // the network, and the throwaway server holds no timers or connections.
      buildServer(env);

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        httpServer.once("error", onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer.removeListener("error", onError);
          resolve();
        });
      });
      reaper = setInterval(reap, REAP_INTERVAL_MS);
      reaper.unref?.();

      const address = httpServer.address();
      const bound =
        address && typeof address === "object"
          ? { host: address.address, port: address.port }
          : { host: config.host, port: config.port };
      return bound;
    },

    async close() {
      if (reaper) clearInterval(reaper);
      reaper = undefined;
      await Promise.all([...sessions.values(), ...pending].map((s) => closeSession(s)));
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // `close()` alone waits for keep-alive sockets to go idle, which an SSE
      // stream never does. Betty is going away; take the sockets with her.
      httpServer.closeAllConnections();
      await closed;
    },
  };
}

/** Where a request is headed, and any token it carried in the path. */
type Route =
  | { kind: "mcp"; token: string | null }
  | { kind: "health" }
  | { kind: "none" };

export function routeFor(pathname: string, config: Pick<HttpConfig, "path">): Route {
  if (pathname === HEALTH_PATH) return { kind: "health" };
  if (pathname === config.path) return { kind: "mcp", token: null };
  const prefix = `${config.path}/`;
  if (pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length);
    // One segment only. `/mcp/<token>/anything` is not an endpoint Betty has.
    if (rest && !rest.includes("/")) return { kind: "mcp", token: decodeSegment(rest) };
  }
  return { kind: "none" };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether this request may talk to Betty. Either credential will do — the
 * header for clients that can send one, the path segment for the connector UIs
 * that only take a URL — and both are compared in constant time.
 */
function authorized(req: IncomingMessage, pathToken: string | null, expected: string): boolean {
  const auth = header(req, "authorization");
  const bearer = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() : undefined;
  // Evaluated without short-circuiting so a request presenting both credentials
  // takes the same work either way.
  const byHeader = bearer !== undefined && secretEquals(bearer, expected);
  const byPath = pathToken !== null && secretEquals(pathToken, expected);
  return byHeader || byPath;
}

/** Constant-time comparison that doesn't leak the expected length. */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do the work, against a same-length buffer, so a wrong length costs
    // what a wrong value costs.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

/** Sentinel: the body was rejected and the response is already written. */
const PARSE_FAILED = Symbol("parse-failed");

/**
 * Read and parse a JSON body, capped. Returns the sentinel when it has already
 * answered the request, so callers stop rather than double-respond.
 */
async function parseBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<unknown | typeof PARSE_FAILED> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      sendError(res, 413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      return PARSE_FAILED;
    }
    throw err;
  }
  if (raw.trim() === "") {
    sendError(res, 400, -32700, "Empty request body");
    return PARSE_FAILED;
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendError(res, 400, -32700, "Parse error");
    return PARSE_FAILED;
  }
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** JSON-RPC shaped, because everything on this endpoint speaks JSON-RPC. */
function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}
