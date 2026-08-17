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
}

/** Records server.tool() registrations without constructing a real McpServer. */
export function captureServer(): {
  server: McpServer;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: ToolHandler
    ) => {
      tools.set(name, { name, description, schema, handler });
    },
  };
  // The tool layer only ever calls .tool(); `as never` keeps the cast honest
  // by not claiming the stub implements the rest of McpServer.
  return { server: server as never, tools };
}

export interface ToolHarness {
  tools: Map<string, CapturedTool>;
  /** Registered tool names, sorted — for exact registration assertions. */
  names(): string[];
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
  const { server, tools } = captureServer();
  register(server);

  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    // Fail on the missing registration rather than on `undefined is not a
    // function` three frames deeper.
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return tool.handler(args);
  };

  const text = async (name: string, args: Record<string, unknown> = {}) =>
    (await call(name, args)).content[0].text;

  return {
    tools,
    names: () => [...tools.keys()].sort(),
    call,
    json: async <T = any>(name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(await text(name, args)) as T,
    text,
  };
}
