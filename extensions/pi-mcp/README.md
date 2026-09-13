# pi-mcp

MCP (Model Context Protocol) client for pi, built on the MCP TypeScript SDK **v1**.
Inspired by [opencode's MCP implementation](https://github.com/anomalyco/opencode) — transport fallback, tolerant tool schemas, progress-aware timeouts, tool list change notifications, per-server status.

Each MCP server's tools show up as normal pi tools named `<server>_<tool>`.

## Setup

This repo's `scripts/bootstrap.sh` links `extensions/pi-mcp` into
`~/.pi/agent/extensions/` and installs runtime dependencies only
(`npm install --omit=dev`).

Standalone install:

```bash
cd ~/.pi/agent/extensions/pi-mcp   # or wherever this directory lives
npm install --omit=dev
```

For type checking, install the dev dependencies too (`npm install`) and run
`npm run typecheck`. They are intentionally heavy — they vendor Pi's type
packages — which is why the bootstrap skips them.

Config file:

```bash
# global, all projects
~/.pi/agent/mcp.json
```

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" }
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

Reload with `/reload` in pi (or restart).

## Config files

Precedence, lowest to highest:

| Scope | Path |
|-------|------|
| global | `~/.pi/agent/mcp.json` |
| project (shared) | `<cwd>/.mcp.json` |
| project (pi) | `<cwd>/.pi/mcp.json` |

Project files are only read for trusted projects. Keys starting with `_` or `$` are ignored, so you can keep commented examples around.

Both `mcpServers` and a bare map of servers work, plus opencode's `mcp` container key.

## Server options

Local (stdio):

| Key | Description |
|-----|-------------|
| `command` | Executable to run |
| `args` | Argument array |
| `env` | Extra environment variables |
| `cwd` | Working directory (relative paths resolve from the session workspace) |
| `enabled` / `disabled` | Toggle without deleting the entry |
| `timeout` | Connect + request timeout in ms (default 30000) |

Remote:

| Key | Description |
|-----|-------------|
| `url` | Server URL |
| `headers` | Request headers (API keys go here) |
| `type` | Optional: `http` (default), `sse`, or `remote`/`local` aliases |
| `enabled` / `disabled` | Toggle without deleting the entry |
| `timeout` | Connect + request timeout in ms |

Remote servers try Streamable HTTP first and fall back to SSE automatically.

Values support `${VAR}`, `${VAR:-fallback}`, and `{env:VAR}` expansion.

## Usage

Tools appear as `server_toolname` (non-alphanumerics become `_`; collisions get a numeric suffix). Descriptions are prefixed with `[MCP: server]`.

```bash
# only MCP tools from the playwright server, plus read-only built-ins
pi --tools read,grep,find,ls,playwright_browser_navigate

# see what a server exposes
/mcp tools playwright
```

### `/mcp` command

| Command | Description |
|---------|-------------|
| `/mcp` or `/mcp status` | Connection status per server |
| `/mcp reload` | Re-read config and reconnect everything |
| `/mcp tools [server]` | Registered pi tool names, mapped back to MCP tool names |
| `/mcp logs <server>` | Server stderr and MCP logging notifications |
| `/mcp connect <server>` | Connect one server on demand |
| `/mcp disconnect <server>` | Close one server and retire its tools |
| `/mcp config` | Config paths, loaded sources, and warnings |

### Resources and prompts

When a connected server advertises resources or prompts, four helper tools are enabled:

- `mcp_list_resources` / `mcp_read_resource`
- `mcp_list_prompts` / `mcp_get_prompt`

They are disabled (and stay out of the prompt) when no server supports them.

## Behavior notes

- **Tool list changes**: servers that send `notifications/tools/list_changed` get re-registered; removed tools are deactivated.
- **Output limits**: text is truncated at pi's 50KB / 2000 line limit. MCP images are attached as image content (over 4MB is replaced with a note).
- **Errors**: an MCP result with `isError` is surfaced to the model as a failed tool call with the returned text.
- **Cleanup**: stdio servers are closed on `session_shutdown`, including a `pgrep`-based sweep of grandchild processes (docker-wrapped servers, etc.).
- **OAuth is not implemented.** `401` responses mark the server as `needs-auth`; use a static header/API key for now.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm run fixture:stdio    # demo MCP server on stdio (tools, resources, prompts, images, errors)
npm run fixture:remote   # demo streamable HTTP server on 127.0.0.1:43117 (requires x-demo-key: secret)
```

Layout:

```
index.ts          pi wiring: tool registration, /mcp command, lifecycle
src/config.ts     config discovery, normalization, env expansion
src/client.ts     MCP SDK client wrapper (transports, catalogs, notifications)
src/schema.ts     MCP JSON Schema -> TypeBox-safe tool parameters
src/format.ts     MCP content blocks -> pi tool result content
test/             smoke-test fixture servers
```

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are dev-only here:
pi resolves them through its extension loader at runtime, and they exist in `node_modules`
only so `tsc` can type-check.
