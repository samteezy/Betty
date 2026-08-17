#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, connectAll } from "./server.js";

/**
 * Entrypoint. The wiring lives in src/server.ts, which takes its environment as
 * a parameter — this file is the only place that reaches for `process.env`, and
 * the only place that owns a transport.
 */
async function main() {
  const { server, backends } = buildServer(process.env);
  await connectAll(backends);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
