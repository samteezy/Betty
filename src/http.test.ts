import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createHttpHost,
  httpEnabled,
  parseHttpConfig,
  routeFor,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_SESSIONS,
  HEALTH_PATH,
  HttpConfig,
  HttpHost,
} from "./http";

/**
 * Remote-transport tests.
 *
 * The unit half drives the config and routing functions directly. The
 * integration half binds a real server on port 0 with a local notes root in a
 * temp directory — no credentials, no network beyond loopback — and talks to it
 * with the SDK's own client, so the handshake, the session header, and the wake
 * gate are exercised the way a phone would exercise them.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

let notesRoot: string;

beforeEach(() => {
  notesRoot = mkdtempSync(join(tmpdir(), "betty-http-"));
});

afterEach(() => {
  rmSync(notesRoot, { recursive: true, force: true });
});

/** A minimal, credential-free Betty: local notes, HTTP transport. */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NOTES_BACKEND: "local",
    NOTES_ROOT: notesRoot,
    BETTY_TRANSPORT: "http",
    BETTY_HTTP_TOKEN: TOKEN,
    ...overrides,
  };
}

describe("httpEnabled", () => {
  it("defaults to stdio", () => {
    expect(httpEnabled({})).toBe(false);
    expect(httpEnabled({ NOTES_BACKEND: "local" })).toBe(false);
  });

  it("serves HTTP on BETTY_TRANSPORT=http", () => {
    expect(httpEnabled({ BETTY_TRANSPORT: "http" })).toBe(true);
    expect(httpEnabled({ BETTY_TRANSPORT: " HTTP " })).toBe(true);
  });

  it("treats a port as the same request", () => {
    expect(httpEnabled({ BETTY_HTTP_PORT: "8765" })).toBe(true);
  });

  it("lets an explicit stdio win over a stray port", () => {
    expect(httpEnabled({ BETTY_TRANSPORT: "stdio", BETTY_HTTP_PORT: "8765" })).toBe(false);
  });

  it("rejects a transport it does not have", () => {
    expect(() => httpEnabled({ BETTY_TRANSPORT: "sse" })).toThrow(/BETTY_TRANSPORT/);
  });
});

describe("parseHttpConfig", () => {
  it("refuses to serve without a token", () => {
    expect(() => parseHttpConfig({})).toThrow(/BETTY_HTTP_TOKEN is required/);
  });

  it("refuses a token short enough to have been typed by hand", () => {
    expect(() => parseHttpConfig({ BETTY_HTTP_TOKEN: "betty" })).toThrow(/at least 16 characters/);
  });

  it("defaults to loopback", () => {
    const config = parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN });
    expect(config.host).toBe(DEFAULT_HTTP_HOST);
    expect(config.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.path).toBe(DEFAULT_HTTP_PATH);
    expect(config.maxSessions).toBe(DEFAULT_MAX_SESSIONS);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.allowedHosts).toEqual([]);
  });

  it("normalizes the endpoint path", () => {
    const at = (path: string) => parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN, BETTY_HTTP_PATH: path }).path;
    expect(at("betty")).toBe("/betty");
    expect(at("/betty/")).toBe("/betty");
    expect(at(" /betty/mcp ")).toBe("/betty/mcp");
  });

  it("rejects a root endpoint and the health path", () => {
    const at = (path: string) => () => parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN, BETTY_HTTP_PATH: path });
    expect(at("/")).toThrow(/below the root/);
    expect(at(HEALTH_PATH)).toThrow(/health endpoint/);
  });

  it("rejects a malformed port, session cap, or timeout", () => {
    expect(() => parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN, BETTY_HTTP_PORT: "http" })).toThrow(
      /BETTY_HTTP_PORT/
    );
    expect(() => parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN, BETTY_HTTP_MAX_SESSIONS: "0" })).toThrow(
      /BETTY_HTTP_MAX_SESSIONS/
    );
    expect(() =>
      parseHttpConfig({ BETTY_HTTP_TOKEN: TOKEN, BETTY_HTTP_SESSION_TIMEOUT_MINUTES: "-1" })
    ).toThrow(/BETTY_HTTP_SESSION_TIMEOUT_MINUTES/);
  });

  it("splits the allow lists", () => {
    const config = parseHttpConfig({
      BETTY_HTTP_TOKEN: TOKEN,
      BETTY_HTTP_ALLOWED_ORIGINS: "https://claude.ai, https://app.example ",
      BETTY_HTTP_ALLOWED_HOSTS: "betty.example",
    });
    expect(config.allowedOrigins).toEqual(["https://claude.ai", "https://app.example"]);
    expect(config.allowedHosts).toEqual(["betty.example"]);
  });
});

describe("routeFor", () => {
  const config = { path: "/mcp" };

  it("finds the endpoint and the health probe", () => {
    expect(routeFor("/mcp", config)).toEqual({ kind: "mcp", token: null });
    expect(routeFor(HEALTH_PATH, config)).toEqual({ kind: "health" });
  });

  it("reads a token out of the path", () => {
    expect(routeFor("/mcp/secret", config)).toEqual({ kind: "mcp", token: "secret" });
    expect(routeFor("/mcp/a%20b", config)).toEqual({ kind: "mcp", token: "a b" });
  });

  it("knows nothing else", () => {
    expect(routeFor("/", config)).toEqual({ kind: "none" });
    expect(routeFor("/mcpx", config)).toEqual({ kind: "none" });
    // A second segment is not a deeper endpoint — it is not an endpoint at all.
    expect(routeFor("/mcp/secret/more", config)).toEqual({ kind: "none" });
  });
});

describe("serving", () => {
  let host: HttpHost;
  let base: string;

  /** Bind on an ephemeral port and return the base URL. */
  async function start(overrides: NodeJS.ProcessEnv = {}, config: Partial<HttpConfig> = {}) {
    const environment = env(overrides);
    host = createHttpHost(environment, {
      config: { ...parseHttpConfig(environment), port: 0, ...config },
      log: () => {},
    });
    const bound = await host.listen();
    base = `http://127.0.0.1:${bound.port}`;
    return base;
  }

  afterEach(async () => {
    await host?.close();
  });

  /** A connected SDK client, authenticating however the caller says. */
  async function connect(init: RequestInit = {}, path = DEFAULT_HTTP_PATH) {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
      requestInit: init,
    });
    await client.connect(transport);
    return { client, transport };
  }

  const bearer: RequestInit = { headers: { Authorization: `Bearer ${TOKEN}` } };

  /**
   * Open a session by hand and read the response to completion, so nothing is
   * left holding the connection. The SDK client keeps a stream open; this is
   * what a request that has finished looks like.
   */
  async function initialize(): Promise<Response> {
    const response = await fetch(`${base}${DEFAULT_HTTP_PATH}`, {
      method: "POST",
      headers: {
        ...(bearer.headers as Record<string, string>),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "by-hand", version: "0.0.0" },
        },
      }),
    });
    await response.text();
    return response;
  }

  it("answers the health probe without a token", async () => {
    await start();
    const response = await fetch(`${base}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses an unauthenticated request", async () => {
    await start();
    const response = await fetch(`${base}${DEFAULT_HTTP_PATH}`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("refuses the wrong token, by header or by path", async () => {
    await start();
    const byHeader = await fetch(`${base}${DEFAULT_HTTP_PATH}`, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-token" },
      body: "{}",
    });
    expect(byHeader.status).toBe(401);
    const byPath = await fetch(`${base}${DEFAULT_HTTP_PATH}/not-the-token`, {
      method: "POST",
      body: "{}",
    });
    expect(byPath.status).toBe(401);
  });

  it("has no other endpoints", async () => {
    await start();
    const response = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(404);
  });

  it("shuts out a browser by default, and lets in an invited origin", async () => {
    await start();
    const refused = await fetch(`${base}${HEALTH_PATH}`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(refused.status).toBe(403);

    await host.close();
    await start({ BETTY_HTTP_ALLOWED_ORIGINS: "https://claude.ai" });
    const allowed = await fetch(`${base}${HEALTH_PATH}`, {
      headers: { Origin: "https://claude.ai" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
  });

  it("enforces an allowed-hosts list when one is configured", async () => {
    await start({ BETTY_HTTP_ALLOWED_HOSTS: "betty.example" });
    const refused = await fetch(`${base}${HEALTH_PATH}`);
    expect(refused.status).toBe(403);
  });

  it("turns a stale session into something a client can act on", async () => {
    await start();
    const response = await fetch(`${base}${DEFAULT_HTTP_PATH}`, {
      method: "POST",
      headers: { ...(bearer.headers as Record<string, string>), "Mcp-Session-Id": "long-gone" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a session-less request that is not an initialize", async () => {
    await start();
    const response = await fetch(`${base}${DEFAULT_HTTP_PATH}`, {
      method: "POST",
      headers: bearer.headers as Record<string, string>,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(400);
  });

  it("serves a whole Betty over the wire, gate and all", async () => {
    await start();
    const { client, transport } = await connect(bearer);

    expect(transport.sessionId).toBeTruthy();
    expect(host.sessionCount).toBe(1);

    // Asleep: the gate is per-session, so a fresh connection starts closed.
    const asleep = await client.listTools();
    expect(asleep.tools.map((tool) => tool.name)).toEqual(["wake_betty"]);

    await client.callTool({ name: "wake_betty", arguments: {} });
    const awake = await client.listTools();
    const names = awake.tools.map((tool) => tool.name);
    expect(names).toContain("search_notes");
    expect(names).toContain("list_skills");

    await transport.terminateSession();
    await client.close();
    expect(host.sessionCount).toBe(0);
  }, 20_000);

  it("accepts the token as a path segment, for clients that send no headers", async () => {
    await start();
    const { client, transport } = await connect({}, `${DEFAULT_HTTP_PATH}/${TOKEN}`);
    expect(transport.sessionId).toBeTruthy();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["wake_betty"]);
    await client.close();
  }, 20_000);

  it("keeps sessions apart", async () => {
    await start();
    const first = await connect(bearer);
    const second = await connect(bearer);
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    expect(host.sessionCount).toBe(2);

    // Waking one leaves the other asleep — a phone must not open the laptop's
    // gate, which is the whole reason a session gets its own Betty.
    await first.client.callTool({ name: "wake_betty", arguments: {} });
    expect((await first.client.listTools()).tools.length).toBeGreaterThan(1);
    expect((await second.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "wake_betty",
    ]);

    await first.client.close();
    await second.client.close();
  }, 20_000);

  it("refuses to open more sessions than it was told to", async () => {
    await start({}, { maxSessions: 1 });
    const first = await connect(bearer);
    expect(host.sessionCount).toBe(1);

    expect((await initialize()).status).toBe(503);
    await first.client.close();
  }, 20_000);

  it("reaps a session the client walked away from", async () => {
    let clock = 0;
    const environment = env();
    host = createHttpHost(environment, {
      config: { ...parseHttpConfig(environment), port: 0, sessionTimeoutMs: 1_000 },
      log: () => {},
      now: () => clock,
    });
    const bound = await host.listen();
    base = `http://127.0.0.1:${bound.port}`;

    // Initialized by hand rather than with the SDK client, which would hold an
    // SSE stream open — and a client still on the line is not an idle one.
    const first = await initialize();
    expect(first.status).toBe(200);
    expect(host.sessionCount).toBe(1);

    // Time passes with no request: the phone lost signal, and the DELETE that
    // would have closed this session cleanly is never coming.
    clock += 60_000;
    const second = await initialize();
    expect(second.status).toBe(200);
    // The abandoned one is gone; only the session just opened remains.
    expect(host.sessionCount).toBe(1);
  }, 20_000);

  it("reports a Betty that cannot start, without taking the process with it", async () => {
    // A notes root that isn't there: fatal for the session, fine for the server.
    const environment = env({ NOTES_ROOT: join(notesRoot, "nope") });
    host = createHttpHost(environment, {
      config: { ...parseHttpConfig(environment), port: 0 },
      log: () => {},
    });
    const bound = await host.listen();
    base = `http://127.0.0.1:${bound.port}`;

    await expect(connect(bearer)).rejects.toThrow();
    expect(host.sessionCount).toBe(0);
    // Still serving.
    expect((await fetch(`${base}${HEALTH_PATH}`)).status).toBe(200);
  }, 20_000);

  it("refuses to start at all when Betty herself is misconfigured", async () => {
    const environment = { BETTY_TRANSPORT: "http", BETTY_HTTP_TOKEN: TOKEN };
    const misconfigured = createHttpHost(environment, {
      config: { ...parseHttpConfig(environment), port: 0 },
      log: () => {},
    });
    await expect(misconfigured.listen()).rejects.toThrow(/No capabilities configured/);
    await misconfigured.close();
  });
});
