/**
 * pi-mcp — Model Context Protocol (v1 SDK) client for pi.
 *
 * Connects to MCP servers declared in `~/.pi/agent/mcp.json` (global) and
 * `.pi/mcp.json` (project, trusted projects only), then exposes each server's
 * tools as pi tools named `<server>_<tool>`. Resource and prompt helpers are
 * registered only while a connected server actually advertises them.
 *
 * Inspired by opencode's MCP implementation: transport fallback
 * (streamable HTTP -> SSE), tolerant tool schema handling, progress-aware
 * request timeouts, tool list change notifications, and per-server status.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { McpConnection, type McpServerStatus, type McpToolDefinition } from "./src/client.ts";
import { GLOBAL_CONFIG_FILE, loadMcpConfig, projectConfigFile, type LoadedMcpConfig } from "./src/config.ts";
import { formatCallToolResult, formatPromptResult, formatResourceResult } from "./src/format.ts";
import { toToolParameters } from "./src/schema.ts";

const STATUS_KEY = "pi-mcp";
const ENTRY_TYPE = "pi-mcp";

/** Tool names pi already owns; MCP tools never shadow them. */
const RESERVED_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

const UTILITY_TOOLS = {
  listResources: "mcp_list_resources",
  readResource: "mcp_read_resource",
  listPrompts: "mcp_list_prompts",
  getPrompt: "mcp_get_prompt",
} as const;

const UTILITY_TOOL_NAMES = Object.values(UTILITY_TOOLS);

const SERVER_PARAM = Type.Optional(
  Type.String({ description: "MCP server name. Omit to query every connected server." }),
);

function sanitizeToolNamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function statusLabel(status: McpServerStatus): string {
  switch (status.state) {
    case "connected":
      return `connected (${status.toolCount} tools${status.resources ? ", resources" : ""}${status.prompts ? ", prompts" : ""})`;
    case "connecting":
      return "connecting";
    case "needs-auth":
      return `needs auth: ${status.error}`;
    case "failed":
      return `failed: ${status.error}`;
    case "disabled":
      return "disabled";
  }
}

export default function piMcp(pi: ExtensionAPI): void {
  const connections = new Map<string, McpConnection>();
  const piToolNames = new Map<string, string>();
  const toolOwners = new Map<string, McpConnection>();
  let utilityToolsRegistered = false;
  let loaded: LoadedMcpConfig | undefined;

  const nameKey = (server: string, tool: string) => `${server}\u0000${tool}`;

  /** Deterministic, collision-free pi tool name for one MCP tool. */
  const toolNameFor = (server: string, tool: string): string => {
    const key = nameKey(server, tool);
    const existing = piToolNames.get(key);
    if (existing) return existing;

    const base = `${sanitizeToolNamePart(server)}_${sanitizeToolNamePart(tool)}`;
    const taken = new Set([...piToolNames.values(), ...UTILITY_TOOL_NAMES, ...RESERVED_TOOL_NAMES]);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix++) {
      candidate = `${base}_${suffix}`;
    }

    piToolNames.set(key, candidate);
    return candidate;
  };

  const activateTools = (names: string[]): void => {
    if (names.length === 0) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  };

  const deactivateTools = (names: string[]): void => {
    if (names.length === 0) return;
    const remove = new Set(names);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !remove.has(name)));
  };

  const statusLines = (): string[] => {
    if (connections.size === 0) {
      const sources = loaded?.sources.length ? `Checked: ${loaded.sources.join(", ")}` : `No config found.`;
      return [
        "No MCP servers configured.",
        sources,
        `Add servers under "mcpServers" in ${GLOBAL_CONFIG_FILE}`,
        `or ${projectConfigFile("<cwd>")} for a single project.`,
      ];
    }

    return [...connections.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((connection) => {
        const version = connection.status.state === "connected" && connection.status.serverName
          ? ` [${connection.status.serverName} ${connection.status.serverVersion ?? ""}]`.trimEnd()
          : "";
        return `• ${connection.name}: ${statusLabel(connection.status)}${version}`;
      });
  };

  const showStatus = (title = "pi-mcp"): void => {
    pi.appendEntry(ENTRY_TYPE, { title, lines: statusLines() });
  };

  const registerMcpTool = (connection: McpConnection, tool: McpToolDefinition): void => {
    const piName = toolNameFor(connection.name, tool.name);
    toolOwners.set(piName, connection);

    pi.registerTool({
      name: piName,
      label: tool.annotations?.title ?? tool.name,
      description: `[MCP: ${connection.name}] ${tool.description?.trim() || tool.name}`,
      parameters: toToolParameters(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const args = (params ?? {}) as Record<string, unknown>;
        const raw = await connection.callTool(tool.name, args, { signal });
        const formatted = formatCallToolResult(raw);

        if (raw.isError) {
          throw new Error(formatted.text || `MCP tool ${connection.name}/${tool.name} failed`);
        }

        return {
          content: formatted.parts,
          details: { server: connection.name, tool: tool.name, truncated: formatted.truncated },
        };
      },
    });
  };

  /** Enable the resource/prompt helper tools only when a server supports them. */
  function syncUtilityTools(): void {
    const live = [...connections.values()].filter((connection) => connection.connected);
    const wantsResources = live.some((connection) => connection.supportsResources());
    const wantsPrompts = live.some((connection) => connection.supportsPrompts());

    if (!utilityToolsRegistered && (wantsResources || wantsPrompts)) {
      utilityToolsRegistered = true;
      registerUtilityTools();
    }

    const desired = new Set<string>();
    if (wantsResources) {
      desired.add(UTILITY_TOOLS.listResources);
      desired.add(UTILITY_TOOLS.readResource);
    }
    if (wantsPrompts) {
      desired.add(UTILITY_TOOLS.listPrompts);
      desired.add(UTILITY_TOOLS.getPrompt);
    }

    activateTools([...desired]);
    deactivateTools(UTILITY_TOOL_NAMES.filter((name) => !desired.has(name)));
  }

  /** Disable and forget every pi tool owned by a connection (close/refresh). */
  const retireConnectionTools = (connection: McpConnection): void => {
    const names = [...toolOwners.entries()]
      .filter(([, owner]) => owner === connection)
      .map(([toolName]) => toolName);
    for (const name of names) toolOwners.delete(name);
    deactivateTools(names);
    syncUtilityTools();
  };

  /** Re-register a server's tools after a list change and retire removed ones. */
  const syncConnectionTools = (connection: McpConnection): void => {
    const previousNames = new Set(
      [...toolOwners.entries()].filter(([, owner]) => owner === connection).map(([name]) => name),
    );

    for (const tool of connection.tools) registerMcpTool(connection, tool);

    const currentNames = new Set(connection.tools.map((tool) => toolNameFor(connection.name, tool.name)));
    const removed = [...previousNames].filter((name) => !currentNames.has(name));
    for (const name of removed) toolOwners.delete(name);
    deactivateTools(removed);

    syncUtilityTools();
  };

  const targetConnections = (server: string | undefined): McpConnection[] => {
    if (server) {
      const connection = connections.get(server);
      if (!connection || !connection.connected) {
        const known = [...connections.keys()].sort().join(", ") || "none";
        throw new Error(`MCP server "${server}" is not connected. Known servers: ${known}`);
      }
      return [connection];
    }

    const live = [...connections.values()].filter((connection) => connection.connected);
    if (live.length === 0) throw new Error("No MCP servers are connected");
    return live;
  };

  function registerUtilityTools(): void {
    pi.registerTool({
      name: UTILITY_TOOLS.listResources,
      label: "MCP: List Resources",
      description:
        "List resources and resource templates exposed by connected MCP servers. Use mcp_read_resource to fetch one.",
      parameters: Type.Object({ server: SERVER_PARAM }),
      async execute(_toolCallId, params) {
        const targets = targetConnections(params.server);
        const lines: string[] = [];

        for (const connection of targets) {
          if (!connection.supportsResources()) continue;
          lines.push(`${connection.name} (${connection.resources.length} resources)`);
          for (const resource of connection.resources) {
            const mime = resource.mimeType ? ` [${resource.mimeType}]` : "";
            lines.push(`- ${resource.uri}${mime} — ${resource.name ?? ""}`);
          }
          if (connection.resourceTemplates.length > 0) {
            lines.push(`${connection.name} templates:`);
            for (const template of connection.resourceTemplates) {
              lines.push(`- ${template.uriTemplate} — ${template.name ?? ""}`);
            }
          }
        }

        if (lines.length === 0) lines.push("No connected MCP server exposes resources.");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { servers: targets.map((connection) => connection.name) },
        };
      },
    });

    pi.registerTool({
      name: UTILITY_TOOLS.readResource,
      label: "MCP: Read Resource",
      description:
        "Read one resource from an MCP server by URI. Get URIs and server names from mcp_list_resources.",
      parameters: Type.Object({
        server: Type.String({ description: "MCP server name" }),
        uri: Type.String({ description: "Resource URI as reported by mcp_list_resources" }),
      }),
      async execute(_toolCallId, params, signal) {
        const [connection] = targetConnections(params.server);
        if (!connection.supportsResources()) {
          throw new Error(`MCP server "${connection.name}" does not support resources`);
        }

        const result = await connection.readResource(params.uri, signal);
        const formatted = formatResourceResult(connection.name, params.uri, result);
        return {
          content: formatted.parts,
          details: { server: connection.name, uri: params.uri, truncated: formatted.truncated },
        };
      },
    });

    pi.registerTool({
      name: UTILITY_TOOLS.listPrompts,
      label: "MCP: List Prompts",
      description: "List prompts exposed by connected MCP servers. Use mcp_get_prompt to render one.",
      parameters: Type.Object({ server: SERVER_PARAM }),
      async execute(_toolCallId, params) {
        const targets = targetConnections(params.server);
        const lines: string[] = [];

        for (const connection of targets) {
          if (!connection.supportsPrompts()) continue;
          lines.push(`${connection.name} (${connection.prompts.length} prompts)`);
          for (const prompt of connection.prompts) {
            const args = prompt.arguments?.map((argument) => argument.name).join(", ");
            lines.push(`- ${prompt.name}${args ? ` (${args})` : ""} — ${prompt.description ?? ""}`);
          }
        }

        if (lines.length === 0) lines.push("No connected MCP server exposes prompts.");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { servers: targets.map((connection) => connection.name) },
        };
      },
    });

    pi.registerTool({
      name: UTILITY_TOOLS.getPrompt,
      label: "MCP: Get Prompt",
      description: "Render a named prompt from an MCP server, with optional string arguments.",
      parameters: Type.Object({
        server: Type.String({ description: "MCP server name" }),
        name: Type.String({ description: "Prompt name from mcp_list_prompts" }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: "Prompt arguments as a string map",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const [connection] = targetConnections(params.server);
        if (!connection.supportsPrompts()) {
          throw new Error(`MCP server "${connection.name}" does not support prompts`);
        }

        const result = await connection.getPrompt(params.name, params.arguments, signal);
        const formatted = formatPromptResult(connection.name, params.name, result);
        return {
          content: formatted.parts,
          details: { server: connection.name, prompt: params.name, truncated: formatted.truncated },
        };
      },
    });
  }

  const closeAllConnections = async (): Promise<void> => {
    const all = [...connections.values()];
    connections.clear();
    await Promise.all(all.map((connection) => connection.close()));
  };

  const connectAll = async (ctx: ExtensionContext): Promise<void> => {
    loaded = await loadMcpConfig(ctx.cwd, ctx.isProjectTrusted());
    for (const warning of loaded.warnings) {
      ctx.ui.notify(`pi-mcp: ${warning}`, "warning");
    }

    const entries = [...loaded.servers.entries()].filter(([, config]) => config.enabled);
    if (entries.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `mcp: connecting ${entries.length}…`);

    await Promise.all(
      entries.map(async ([name, config]) => {
        const connection = new McpConnection(name, config, {
          onToolsChanged: (changed) => {
            try {
              syncConnectionTools(changed);
            } catch (error) {
              ctx.ui.notify(`pi-mcp: ${name} tool refresh failed: ${String(error)}`, "error");
            }
          },
          onClosed: (closed) => {
            retireConnectionTools(closed);
            updateStatusLabel(ctx);
          },
        });

        connections.set(name, connection);
        await connection.connect(ctx.cwd);
      }),
    );

    // Register tools in a stable order so collision suffixes never depend on
    // which server happened to connect first.
    for (const [name] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      const connection = connections.get(name);
      if (!connection) continue;
      for (const tool of [...connection.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        registerMcpTool(connection, tool);
      }
    }

    syncUtilityTools();
    updateStatusLabel(ctx);
  };

  const updateStatusLabel = (ctx: ExtensionContext): void => {
    const all = [...connections.values()];
    const connected = all.filter((connection) => connection.connected).length;
    ctx.ui.setStatus(STATUS_KEY, all.length === 0 ? undefined : `mcp ${connected}/${all.length}`);
  };

  const reload = async (ctx: ExtensionContext): Promise<void> => {
    await closeAllConnections();
    piToolNames.clear();
    toolOwners.clear();
    await connectAll(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await connectAll(ctx);
    } catch (error) {
      ctx.ui.notify(`pi-mcp: startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    await closeAllConnections();
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { title?: string; lines?: string[] } | undefined;
    const title = theme.fg("accent", theme.bold(data?.title ?? "pi-mcp"));
    const lines = data?.lines ?? [];
    return new Text([title, ...lines.map((line) => theme.fg("dim", line))].join("\n"), 0, 0);
  });

  pi.registerCommand("mcp", {
    description: "MCP servers: /mcp [status|reload|tools [server]|logs <server>|connect <server>|disconnect <server>|config]",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["status", "reload", "tools", "logs", "connect", "disconnect", "config"];
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        return subcommands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      }

      const [subcommand, partial = ""] = parts;
      if (!["tools", "logs", "connect", "disconnect"].includes(subcommand)) return null;
      return [...connections.keys()]
        .filter((name) => name.startsWith(partial))
        .map((name) => ({ value: `${subcommand} ${name}`, label: name }));
    },
    handler: async (args, ctx) => {
      const [subcommand = "status", target] = args.trim().split(/\s+/).filter(Boolean);

      switch (subcommand) {
        case "status":
          showStatus();
          return;

        case "config": {
          const lines = [
            `global:  ${GLOBAL_CONFIG_FILE}`,
            `project: ${projectConfigFile(ctx.cwd)}${ctx.isProjectTrusted() ? "" : " (project not trusted)"}`,
            ...(loaded?.sources.length ? [`loaded:  ${loaded.sources.join(", ")}`] : []),
            ...(loaded?.warnings.length ? ["warnings:", ...loaded.warnings.map((warning) => `- ${warning}`)] : []),
          ];
          pi.appendEntry(ENTRY_TYPE, { title: "pi-mcp config", lines });
          return;
        }

        case "reload":
          await reload(ctx);
          showStatus("pi-mcp reloaded");
          return;

        case "tools": {
          let selected: McpConnection[];
          if (target) {
            const connection = connections.get(target);
            if (!connection) {
              ctx.ui.notify(`Unknown MCP server: ${target}`, "error");
              return;
            }
            selected = [connection];
          } else {
            selected = [...connections.values()];
          }
          const lines = selected.flatMap((connection) => {
            if (connection.tools.length === 0) return [`• ${connection.name}: no tools`];
            return [
              `• ${connection.name}:`,
              ...connection.tools.map(
                (tool) => `  - ${toolNameFor(connection.name, tool.name)} ← ${tool.name}`,
              ),
            ];
          });
          pi.appendEntry(ENTRY_TYPE, { title: "pi-mcp tools", lines: lines.length ? lines : ["No tools."] });
          return;
        }

        case "logs": {
          if (!target) {
            ctx.ui.notify("Usage: /mcp logs <server>", "warning");
            return;
          }
          const connection = connections.get(target);
          if (!connection) {
            ctx.ui.notify(`Unknown MCP server: ${target}`, "error");
            return;
          }
          const lines = [
            `status: ${statusLabel(connection.status)}`,
            ...(connection.log.length > 0
              ? connection.log.map((line) => `[${line.level}] ${line.text}`)
              : ["No server logs yet."]),
          ];
          pi.appendEntry(ENTRY_TYPE, { title: `pi-mcp logs: ${target}`, lines });
          return;
        }

        case "connect": {
          if (!target) {
            ctx.ui.notify("Usage: /mcp connect <server>", "warning");
            return;
          }
          const config = loaded?.servers.get(target);
          if (!config) {
            ctx.ui.notify(`Unknown MCP server: ${target}`, "error");
            return;
          }
          await connections.get(target)?.close();
          const connection = new McpConnection(target, { ...config, enabled: true }, {
            onToolsChanged: (changed) => syncConnectionTools(changed),
            onClosed: (closed) => {
              retireConnectionTools(closed);
              updateStatusLabel(ctx);
            },
          });
          connections.set(target, connection);
          await connection.connect(ctx.cwd);
          for (const tool of [...connection.tools].sort((a, b) => a.name.localeCompare(b.name))) {
            registerMcpTool(connection, tool);
          }
          syncUtilityTools();
          updateStatusLabel(ctx);
          showStatus(`pi-mcp: ${target} ${statusLabel(connection.status)}`);
          return;
        }

        case "disconnect": {
          if (!target) {
            ctx.ui.notify("Usage: /mcp disconnect <server>", "warning");
            return;
          }
          const connection = connections.get(target);
          if (!connection) {
            ctx.ui.notify(`Unknown MCP server: ${target}`, "error");
            return;
          }
          retireConnectionTools(connection);
          await connection.close();
          updateStatusLabel(ctx);
          showStatus(`pi-mcp: ${target} disconnected`);
          return;
        }

        default:
          ctx.ui.notify(`Unknown /mcp subcommand: ${subcommand}`, "warning");
      }
    },
  });
}
