/**
 * Minimal *remote* MCP server (streamable HTTP, stateless) used to smoke-test
 * the pi-mcp extension's remote transport and header pass-through.
 *
 *   node test/fixture-remote-server.mjs [port]
 *
 * Every request must carry `x-demo-key: secret`, so a successful tool call
 * proves configured headers reach the server. Port defaults to 43117.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";

const port = Number.parseInt(process.argv[2] ?? "43117", 10);
const REQUIRED_KEY = "secret";

function buildServer() {
  const server = new McpServer({ name: "demo-remote", version: "1.0.0" });
  server.registerTool(
    "ping",
    { title: "Ping", description: "Returns pong, proving the remote transport and headers work." },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  server.registerResource(
    "remote-readme",
    "demo-remote://readme",
    { title: "Remote readme", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "hello from the remote resource", mimeType: "text/plain" }] }),
  );
  return server;
}

createServer(async (req, res) => {
  if (req.headers["x-demo-key"] !== REQUIRED_KEY) {
    res.writeHead(401, { "content-type": "text/plain" }).end("missing or invalid x-demo-key");
    return;
  }

  // Stateless mode: one server + transport per request, no session tracking.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(port, "127.0.0.1", () => {
  console.error(`demo-remote MCP server listening on http://127.0.0.1:${port}/mcp`);
});
