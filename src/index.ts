#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, connectAll } from "./server.js";
import { createHttpHost, httpEnabled, HEALTH_PATH } from "./http.js";

/**
 * Entrypoint. The wiring lives in src/server.ts, which takes its environment as
 * a parameter — this file is the only place that reaches for `process.env`, and
 * the only place that owns a transport.
 *
 * Two transports now. Stdio is the default and behaves exactly as it always
 * has: one Betty, one client, for the life of the process. `BETTY_TRANSPORT=http`
 * (or simply setting `BETTY_HTTP_PORT`) serves Streamable HTTP instead, for
 * running Betty on a machine at home and reaching her from a phone — see
 * src/http.ts, which builds one Betty per client session.
 */
async function main() {
  if (httpEnabled(process.env)) {
    await serveHttp();
    return;
  }
  const { server, backends } = buildServer(process.env);
  await connectAll(backends);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function serveHttp() {
  const host = createHttpHost(process.env);
  const { host: bound, port } = await host.listen();
  // stderr, not stdout: the same discipline stdio mode requires, so that piping
  // Betty anywhere never mixes log lines into a protocol stream.
  process.stderr.write(
    `betty-mcp: listening on http://${bound}:${port}${host.config.path} ` +
      `(health: http://${bound}:${port}${HEALTH_PATH})\n`
  );

  // Shut sessions down properly on the way out, so a restart doesn't leave mail
  // connections open on the server's side of the wire.
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`betty-mcp: ${signal} received, closing\n`);
    host
      .close()
      .catch((err) => process.stderr.write(`betty-mcp: error while closing: ${err}\n`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
