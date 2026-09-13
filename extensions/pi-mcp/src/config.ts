/**
 * MCP server config loading for pi-mcp-v1.
 *
 * Reads `<home>/mcp.json` (global) and `<cwd>/.pi/mcp.json` (project) and merges
 * them by server name, project entries winning. The file format follows the
 * de-facto `mcpServers` shape used by Claude Code, Cursor, LM Studio, etc.:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "context7": { "url": "https://mcp.context7.com/mcp", "headers": { "CONTEXT7_API_KEY": "..." } },
 *     "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
 *     "fetch": { "type": "sse", "url": "http://localhost:3001/sse" }
 *   }
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StdioServerConfig {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  timeout?: number;
}

export interface RemoteServerConfig {
  kind: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeout?: number;
}

export type McpServerConfig = StdioServerConfig | RemoteServerConfig;

export interface LoadedMcpConfig {
  /** Merged server configs, keyed by server name. */
  servers: Map<string, McpServerConfig>;
  /** Config files that were read, for `/mcp status` output. */
  sources: string[];
  /** Non-fatal problems, e.g. malformed entries or unset env vars. */
  warnings: string[];
}

export const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "mcp.json");

export function projectConfigFile(cwd: string): string {
  return join(cwd, ".pi", "mcp.json");
}

/** Shared project config used by other MCP clients (Claude Code, Cursor, ...). */
export function sharedProjectConfigFile(cwd: string): string {
  return join(cwd, ".mcp.json");
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export function requestTimeout(config: McpServerConfig): number {
  return config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
}

/** Expand `${VAR}`, `${VAR:-fallback}`, and `{env:VAR}` references. Unset vars expand to "". */
function expandEnv(value: string, warnings: string[], where: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_match, name: string, fallback?: string) => {
      const found = process.env[name];
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      warnings.push(`${where}: environment variable ${name} is not set`);
      return "";
    })
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const found = process.env[name];
      if (found !== undefined) return found;
      warnings.push(`${where}: environment variable ${name} is not set`);
      return "";
    });
}

function expandEnvRecord(
  input: Record<string, unknown>,
  warnings: string[],
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = expandEnv(value, warnings, `${where}.${key}`);
  }
  return out;
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Normalize one raw server entry. Supports the `command`/`args`/`env`/`cwd`
 * stdio shape and the `url`/`headers` remote shape, plus opencode-style
 * `type: "local" | "remote"` aliases.
 */
function normalizeServer(
  name: string,
  raw: unknown,
  warnings: string[],
  baseDir: string,
): McpServerConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`server "${name}": expected an object`);
    return undefined;
  }

  const entry = raw as Record<string, unknown>;
  const where = `server "${name}"`;
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  // `disabled` is used by Kiro/LM Studio style configs, `enabled` by opencode.
  const enabled = entry.enabled !== false && entry.disabled !== true;
  const timeout = optionalPositiveNumber(entry.timeout);
  const url = typeof entry.url === "string" ? expandEnv(entry.url, warnings, where) : undefined;
  const command = typeof entry.command === "string" ? entry.command : undefined;

  const wantsStdio = type === "local" || type === "stdio";
  const wantsRemote = type === "remote" || type === "http" || type === "streamable-http" || type === "sse";
  const isRemote = url !== undefined && (wantsRemote || !wantsStdio || command === undefined);

  if (isRemote) {
    const headers = expandEnvRecord(
      typeof entry.headers === "object" && entry.headers !== null ? (entry.headers as Record<string, unknown>) : {},
      warnings,
      where,
    );
    return {
      kind: type === "sse" ? "sse" : "http",
      url: url!,
      headers,
      enabled,
      timeout,
    };
  }

  if (command) {
    const env = expandEnvRecord(
      typeof entry.env === "object" && entry.env !== null ? (entry.env as Record<string, unknown>) : {},
      warnings,
      where,
    );
    const cwdValue = typeof entry.cwd === "string" ? entry.cwd : undefined;
    return {
      kind: "stdio",
      command,
      args: optionalStringList(entry.args) ?? [],
      env,
      cwd: cwdValue ? resolve(baseDir, cwdValue) : undefined,
      enabled,
      timeout,
    };
  }

  warnings.push(`${where}: needs either "command" (stdio) or "url" (remote)`);
  return undefined;
}

function parseConfigFile(
  text: string,
  path: string,
  warnings: string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${path}: expected a JSON object`);
    return {};
  }

  const root = parsed as Record<string, unknown>;
  const container = root.mcpServers ?? root.mcp;
  if (typeof container === "object" && container !== null && !Array.isArray(container)) {
    return container as Record<string, unknown>;
  }
  // Allow a bare map of servers, ignoring common metadata keys.
  const bare: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === "version" || key === "$schema") continue;
    bare[key] = value;
  }
  return bare;
}

async function readConfigFile(path: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  return parseConfigFile(text, path, warnings);
}

/**
 * Load and merge MCP server configs. Project config is only read when the
 * project is trusted, matching how pi treats other project-local resources.
 */
export async function loadMcpConfig(cwd: string, projectTrusted: boolean): Promise<LoadedMcpConfig> {
  const warnings: string[] = [];
  const sources: string[] = [];
  const servers = new Map<string, McpServerConfig>();

  const globalPath = GLOBAL_CONFIG_FILE;
  const globalEntries = await readConfigFile(globalPath, warnings);
  if (globalEntries) sources.push(globalPath);

  const projectPath = projectConfigFile(cwd);
  const sharedProjectPath = sharedProjectConfigFile(cwd);
  const projectEntries = projectTrusted ? await readConfigFile(projectPath, warnings) : undefined;
  if (projectEntries) sources.push(projectPath);
  const sharedProjectEntries = projectTrusted
    ? await readConfigFile(sharedProjectPath, warnings)
    : undefined;
  if (sharedProjectEntries) sources.push(sharedProjectPath);

  for (const entries of [globalEntries, sharedProjectEntries, projectEntries]) {
    if (!entries) continue;
    for (const [name, raw] of Object.entries(entries)) {
      // Allow comment-ish keys such as `_examples` or `$schema` in any file.
      if (name.startsWith("_") || name.startsWith("$")) continue;
      // Relative `cwd` values resolve against the session workspace.
      const normalized = normalizeServer(name, raw, warnings, cwd);
      if (normalized) servers.set(name, normalized);
    }
  }

  return { servers, sources, warnings };
}
