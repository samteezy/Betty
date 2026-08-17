import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Test harness for the MCP tool layer.
 *
 * Registering tools against a real McpServer would drag in a transport and a
 * client handshake for what is really a plain function call. Instead we hand
 * `register*Tools` a duck-typed object that records what it was given, then
 * invoke the captured handlers directly.
 *
 * Excluded from the published build — see `tsconfig.json`.
 */

export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<ToolResult>;

export interface CapturedTool {
  name: string;
  description: string;
  /** The raw Zod shape passed to server.tool(), for schema assertions. */
  schema: unknown;
  handler: ToolHandler;
  /**
   * Stands in for the SDK's `RegisteredTool.enabled`. The wake gate flips this
   * field on the handle `server.tool()` returns, so the stub has to return one
   * for the gate to have anything to hold.
   */
  enabled: boolean;
}

/** Records server.tool() registrations without constructing a real McpServer. */
export function captureServer(): {
  server: McpServer;
  tools: Map<string, CapturedTool>;
  listChanged: { count: number };
} {
  const tools = new Map<string, CapturedTool>();
  const listChanged = { count: 0 };
  const server = {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: ToolHandler
    ) => {
      const captured: CapturedTool = {
        name,
        description,
        schema,
        handler,
        enabled: true,
      };
      tools.set(name, captured);
      return captured;
    },
    /** The wake gate notifies through this; tests can count the calls. */
    sendToolListChanged: () => {
      listChanged.count += 1;
    },
  };
  // The tool layer only ever calls .tool(); `as never` keeps the cast honest
  // by not claiming the stub implements the rest of McpServer.
  return { server: server as never, tools, listChanged };
}

export interface ToolHarness {
  tools: Map<string, CapturedTool>;
  /**
   * Enabled tool names, sorted — what a client's `tools/list` would return.
   * A gated-but-registered tool is deliberately absent, since being registered
   * is not the same as being reachable.
   */
  names(): string[];
  /** Every registered name, enabled or not. */
  allNames(): string[];
  /** How many `tools/list_changed` notifications have been sent. */
  listChangedCount(): number;
  /** Invoke a tool handler. Throws if the tool was never registered. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Invoke a tool and JSON.parse its text payload. Defaults to `any` because
   * assertions on parsed JSON are inherently untyped; pass a type parameter
   * when a test wants the check.
   */
  json<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Invoke a tool and return its text payload verbatim. */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
}

/**
 * Register a tool module and get back handles for driving it.
 *
 *   const h = harness((s) => registerTaskTools(s, backend, { defaultCalendar: "Work" }));
 *   const tasks = await h.json("list_tasks");
 */
export function harness(register: (server: McpServer) => void): ToolHarness {
  const { server, tools, listChanged } = captureServer();
  register(server);

  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    // Fail on the missing registration rather than on `undefined is not a
    // function` three frames deeper.
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    // The SDK refuses to dispatch to a disabled tool, so a test that reaches
    // one through the gate should fail here rather than quietly succeed.
    if (!tool.enabled) throw new Error(`Tool ${name} disabled`);
    return tool.handler(args);
  };

  const text = async (name: string, args: Record<string, unknown> = {}) =>
    (await call(name, args)).content[0].text;

  return {
    tools,
    names: () =>
      [...tools.values()].filter((t) => t.enabled).map((t) => t.name).sort(),
    allNames: () => [...tools.keys()].sort(),
    listChangedCount: () => listChanged.count,
    call,
    json: async <T = any>(name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(await text(name, args)) as T,
    text,
  };
}
