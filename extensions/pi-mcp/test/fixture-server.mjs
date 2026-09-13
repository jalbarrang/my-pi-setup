/**
 * Minimal MCP server used to smoke-test the pi-mcp extension.
 *
 *   node test/fixture-server.mjs
 *
 * Covers: text results, structured output, image content, error results,
 * resources, resource templates, prompts, and a schema using JSON Schema
 * keywords that TypeBox does not natively accept (`format`, `nullable`).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool(
  "add",
  {
    title: "Add integers",
    description: "Add two integers and return the sum.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

server.registerTool(
  "echo_schema",
  {
    title: "Echo schema",
    description: "Accept a loosely-typed payload and echo it back.",
    inputSchema: {
      query: z.string().describe("Text to echo"),
      when: z.string().describe("ISO timestamp"),
      optional: z.string().nullable().optional(),
    },
  },
  async ({ query, when, optional }) => ({
    content: [{ type: "text", text: JSON.stringify({ query, when, optional: optional ?? null }) }],
  }),
);

server.registerTool(
  "screenshot",
  { title: "Tiny image", description: "Return a 1x1 PNG to test image content handling." },
  async () => ({ content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }] }),
);

server.registerTool(
  "fail",
  { title: "Fail", description: "Always returns an MCP error result." },
  async () => ({ content: [{ type: "text", text: "intentional failure" }], isError: true }),
);

server.registerTool(
  "link",
  { title: "Resource link", description: "Returns a resource_link content block." },
  async () => ({
    content: [{ type: "resource_link", uri: "demo://readme", name: "readme", description: "the demo readme" }],
  }),
);

server.registerResource(
  "readme",
  "demo://readme",
  { title: "Demo readme", description: "Static text resource", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "hello from the demo resource", mimeType: "text/plain" }] }),
);

server.registerResource(
  "user",
  new ResourceTemplate("demo://user/{name}", { list: undefined }),
  { title: "User profile", description: "Templated resource", mimeType: "text/plain" },
  async (uri, variables) => ({
    contents: [{ uri: uri.href, text: `profile for ${variables.name}`, mimeType: "text/plain" }],
  }),
);

server.registerPrompt(
  "greet",
  { title: "Greet", description: "Greeting prompt", argsSchema: { name: z.string() } },
  async ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Please greet ${name} warmly.` } }],
  }),
);

await server.connect(new StdioServerTransport());
