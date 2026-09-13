/**
 * Thin wrapper around the MCP TypeScript SDK v1 client.
 *
 * One `McpConnection` owns one server: transport setup (stdio / streamable
 * HTTP / SSE), capability discovery, catalog pagination, notification
 * handling, and cleanup. The pi extension layer turns the catalogs into pi
 * tools; this module stays free of pi value imports.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool as McpToolDefinition,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { McpServerConfig } from "./config.ts";
import { requestTimeout } from "./config.ts";

const execFileAsync = promisify(execFile);

const CLIENT_INFO = { name: "pi-mcp", version: "0.1.0" } as const;
const MAX_LIST_PAGES = 100;
const MAX_LOG_LINES = 50;

export type { McpToolDefinition };
export type McpCallToolResult = CallToolResult;
export type McpReadResourceResult = ReadResourceResult;
export type McpGetPromptResult = GetPromptResult;
export type McpPrompt = Prompt;
export type McpResource = Resource;
export type McpResourceTemplate = ResourceTemplate;

export type McpServerStatus =
  | { state: "connecting" }
  | {
      state: "connected";
      toolCount: number;
      resources: boolean;
      prompts: boolean;
      serverName?: string;
      serverVersion?: string;
    }
  | { state: "failed"; error: string }
  | { state: "needs-auth"; error: string }
  | { state: "disabled" };

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

export interface McpConnectionEvents {
  /** A connected server announced a tool list change; re-register its tools. */
  onToolsChanged?: (connection: McpConnection) => void;
  /** The transport closed after a successful connect. */
  onClosed?: (connection: McpConnection) => void;
}

/** Server log/notification line, newest last. */
export interface McpLogLine {
  level: string;
  text: string;
}

export interface CallToolOptions {
  signal?: AbortSignal;
  onProgress?: () => void;
}

/** Follow `nextCursor` until the server stops paginating. */
async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor: string | undefined) => Promise<R>,
  items: (result: R) => T[],
): Promise<T[]> {
  const collected: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await list(cursor);
    collected.push(...items(result));
    const next = result.nextCursor;
    if (next === undefined) return collected;
    if (seen.has(next)) throw new Error(`MCP list returned a duplicate cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Distinguish a real tool result from the SDK's legacy `{ toolResult }` shape. */
function isCallToolResult(value: unknown): value is McpCallToolResult {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { content?: unknown }).content);
}

/** SIGTERM any grandchildren so container-wrapped servers do not leak processes. */
async function killDescendants(pid: number): Promise<void> {
  if (process.platform === "win32") return;

  const queue = [pid];
  for (let index = 0; index < queue.length; index++) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-P", String(queue[index])]);
      for (const line of stdout.split("\n")) {
        const childPid = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(childPid) && !queue.includes(childPid)) queue.push(childPid);
      }
    } catch {
      // pgrep exits non-zero when there are no children.
    }
  }

  for (const childPid of queue.slice(1)) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

export class McpConnection {
  readonly name: string;
  readonly config: McpServerConfig;

  status: McpServerStatus = { state: "connecting" };
  tools: McpToolDefinition[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];
  resourceTemplates: McpResourceTemplate[] = [];
  readonly log: McpLogLine[] = [];

  private client: Client | undefined;
  private transport: McpTransport | undefined;
  private closed = false;
  private events: McpConnectionEvents;

  constructor(name: string, config: McpServerConfig, events: McpConnectionEvents) {
    this.name = name;
    this.config = config;
    this.events = events;
    if (!config.enabled) this.status = { state: "disabled" };
  }

  get connected(): boolean {
    return this.status.state === "connected" && this.client !== undefined;
  }

  /**
   * The live SDK client. Available as soon as the transport handshake finishes,
   * which is before `status` flips to `connected` (catalogs load in between).
   */
  get rawClient(): Client | undefined {
    return this.client;
  }

  supportsResources(): boolean {
    return this.client?.getServerCapabilities()?.resources !== undefined;
  }

  supportsPrompts(): boolean {
    return this.client?.getServerCapabilities()?.prompts !== undefined;
  }

  private recordLog(level: string, text: string): void {
    this.log.push({ level, text });
    if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
  }

  private createClient(cwd: string): Client {
    const client = new Client(CLIENT_INFO, { capabilities: { roots: {} } });
    const rootUri = pathToFileURL(cwd).href;

    // Tell the server which workspace it is operating in. Most servers ignore
    // roots; those that support it use them to scope filesystem access.
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: rootUri, name: basename(cwd) }],
    }));

    return client;
  }

  private buildRemoteTransports(): Array<{ label: string; transport: McpTransport }> {
    if (this.config.kind === "stdio") return [];

    const url = new URL(this.config.url);
    const requestInit = Object.keys(this.config.headers).length > 0 ? { headers: this.config.headers } : undefined;

    if (this.config.kind === "sse") {
      return [{ label: "SSE", transport: new SSEClientTransport(url, { requestInit }) }];
    }

    return [
      { label: "StreamableHTTP", transport: new StreamableHTTPClientTransport(url, { requestInit }) },
      { label: "SSE", transport: new SSEClientTransport(url, { requestInit }) },
    ];
  }

  private buildStdioTransport(cwd: string): McpTransport {
    if (this.config.kind !== "stdio") throw new Error("not a stdio server");

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    return new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd ?? cwd,
      env: { ...env, ...this.config.env },
      stderr: "pipe",
    });
  }

  /** Connect once. Never throws; inspect `status` for the outcome. */
  async connect(cwd: string): Promise<void> {
    if (!this.config.enabled) {
      this.status = { state: "disabled" };
      return;
    }

    this.status = { state: "connecting" };
    const timeout = requestTimeout(this.config);
    const attempts =
      this.config.kind === "stdio"
        ? [{ label: "stdio", transport: this.buildStdioTransport(cwd) }]
        : this.buildRemoteTransports();

    // Collect every attempt's error so transport fallback stays visible in
    // `/mcp status` instead of only reporting the last (often SSE) failure.
    const failures: string[] = [];
    let needsAuth = false;

    for (const { label, transport } of attempts) {
      const client = this.createClient(cwd);
      try {
        await client.connect(transport, { timeout });
      } catch (error) {
        await transport.close().catch(() => {});
        if (error instanceof UnauthorizedError || /401|unauthorized|oauth/i.test(toMessage(error))) {
          needsAuth = true;
        }
        failures.push(`${label}: ${toMessage(error)}`);
        continue;
      }

      this.client = client;
      this.transport = transport;
      this.attachNotifications(client, transport, timeout);

      try {
        await this.fetchCatalogs(timeout);
      } catch (error) {
        await this.disconnectClient();
        failures.push(`${label} catalog: ${toMessage(error)}`);
        continue;
      }

      const version = client.getServerVersion();
      this.status = {
        state: "connected",
        toolCount: this.tools.length,
        resources: this.supportsResources(),
        prompts: this.supportsPrompts(),
        serverName: version?.name,
        serverVersion: version?.version,
      };
      return;
    }

    this.client = undefined;
    this.transport = undefined;
    const detail = failures.join("; ") || "connection failed";
    this.status = needsAuth
      ? {
          state: "needs-auth",
          error: `${detail} (OAuth is not supported yet; use a static header or API key)`,
        }
      : { state: "failed", error: detail };
  }

  private attachNotifications(client: Client, transport: McpTransport, timeout: number): void {
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString().trimEnd();
        if (text) this.recordLog("stderr", text);
      });
    }

    client.onclose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.transport = undefined;
      this.status = { state: "failed", error: "connection closed" };
      this.events.onClosed?.(this);
    };

    client.onerror = (error: Error) => {
      this.recordLog("error", toMessage(error));
    };

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const { level, logger, data } = notification.params;
      const body = typeof data === "string" ? data : JSON.stringify(data);
      this.recordLog(level, logger ? `${logger}: ${body}` : body);
    });

    if (client.getServerCapabilities()?.tools) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(timeout).then(() => this.events.onToolsChanged?.(this));
      });
    }
  }

  /** Reload tool/resource/prompt catalogs from the connected server. */
  async fetchCatalogs(timeout = requestTimeout(this.config)): Promise<void> {
    const client = this.rawClient;
    if (!client) return;

    const capabilities = client.getServerCapabilities();
    this.tools = capabilities?.tools
      ? await paginate(
          (cursor) => client.listTools(cursor === undefined ? {} : { cursor }, { timeout }),
          (result) => result.tools,
        )
      : [];
    this.resources = capabilities?.resources
      ? await paginate(
          (cursor) => client.listResources(cursor === undefined ? {} : { cursor }, { timeout }),
          (result) => result.resources,
        )
      : [];
    this.resourceTemplates = capabilities?.resources
      ? await paginate(
          (cursor) => client.listResourceTemplates(cursor === undefined ? {} : { cursor }, { timeout }),
          (result) => result.resourceTemplates,
        )
      : [];
    this.prompts = capabilities?.prompts
      ? await paginate(
          (cursor) => client.listPrompts(cursor === undefined ? {} : { cursor }, { timeout }),
          (result) => result.prompts,
        )
      : [];

    if (this.status.state === "connected") {
      this.status = { ...this.status, toolCount: this.tools.length };
    }
  }

  async refreshTools(timeout = requestTimeout(this.config)): Promise<void> {
    const client = this.rawClient;
    if (!client || !client.getServerCapabilities()?.tools) {
      this.tools = [];
      return;
    }

    this.tools = await paginate(
      (cursor) => client.listTools(cursor === undefined ? {} : { cursor }, { timeout }),
      (result) => result.tools,
    );
    if (this.status.state === "connected") {
      this.status = { ...this.status, toolCount: this.tools.length };
    }
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallToolOptions = {}): Promise<McpCallToolResult> {
    const client = this.rawClient;
    if (!client) throw new Error(`MCP server "${this.name}" is not connected`);

    // `onprogress` must be present for the SDK to attach a progress token; we
    // then let progress notifications reset the per-request timeout.
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      signal: options.signal,
      timeout: requestTimeout(this.config),
      resetTimeoutOnProgress: true,
      onprogress: () => options.onProgress?.(),
    });

    // The SDK types include a legacy `{ toolResult }` shape; reject it explicitly
    // instead of letting it surface as a confusing downstream failure.
    if (!isCallToolResult(result)) {
      throw new Error(`MCP server "${this.name}" returned a legacy tool result without content`);
    }
    return result;
  }

  async listResources(): Promise<McpResource[]> {
    return this.resources;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult> {
    const client = this.rawClient;
    if (!client) throw new Error(`MCP server "${this.name}" is not connected`);
    return client.readResource({ uri }, { timeout: requestTimeout(this.config), signal });
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult> {
    const client = this.rawClient;
    if (!client) throw new Error(`MCP server "${this.name}" is not connected`);
    return client.getPrompt({ name, arguments: args }, { timeout: requestTimeout(this.config), signal });
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (!client) return;

    client.onclose = undefined;

    // Kill grandchildren while the parent is still alive so `pgrep -P` can
    // find them; transport.close() then terminates the direct child.
    if (transport instanceof StdioClientTransport) {
      const pid = transport.pid;
      if (typeof pid === "number") await killDescendants(pid);
    }

    await client.close().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.disconnectClient();
    if (this.status.state === "connected") this.status = { state: "disabled" };
  }
}
