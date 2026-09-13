# Setup

## New machine

Install Pi using its official instructions and clone this repository. Then run the bootstrap for your platform.

**macOS/Linux**

```bash
./scripts/bootstrap.sh
```

**Windows (PowerShell 7+)**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
```

The scripts are idempotent. When a managed target already exists, it is moved into `~/.pi/agent/backups/<timestamp>/` before replacement. PowerShell uses symbolic links when available, falling back to directory junctions and file copies. Enable Windows Developer Mode if you want symbolic links without an elevated terminal.

Skip extension dependency installation when dependencies are already installed:

```bash
./scripts/bootstrap.sh --skip-deps
```

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -SkipDeps
```

## Machine-only settings

Shared preferences live in `config/settings.shared.json`. Put machine-specific overrides in the ignored file:

```bash
cp config/settings.local.example.json config/settings.local.json
```

```powershell
Copy-Item config/settings.local.example.json config/settings.local.json
```

The example enables local checkouts of `pi-workflows` and `pi-linear`. Package paths are resolved from the generated `~/.pi/agent/settings.json`; edit them if the repositories use another location.

You can also set a machine-specific npm wrapper:

```json
{
  "npmCommand": ["mise", "exec", "node@22", "--", "npm"]
}
```

Local settings override shared settings. Existing settings not managed by either file are preserved.

## Context7

Context7 credentials are intentionally machine-local:

```bash
cp extensions/context7/config.example.json extensions/context7/config.json
```

```powershell
Copy-Item extensions/context7/config.example.json extensions/context7/config.json
```

Replace the placeholder with the machine's API key. `config.json` is ignored by Git. If a Context7 config already exists under `~/.pi/agent/extensions/context7/`, the bootstrap script migrates it into this checkout before linking the directory.

## MCP servers

MCP server config is machine-local, like Context7 credentials:

```bash
~/.pi/agent/mcp.json
```

Edit it directly (or use `.pi/mcp.json` / `.mcp.json` per project, which the
`pi-mcp` extension reads only for trusted projects). It is created empty on
first run and is never part of this repo, so API keys stay off Git. See
[`extensions/pi-mcp/README.md`](extensions/pi-mcp/README.md) for the format,
server options, and the `/mcp` command.

## Authentication and private state

Run `pi`, then `/login` on each machine. Never copy or commit:

- `auth.json`
- `trust.json`
- provider or service credentials
- sessions, caches, or workflow artifacts

## Update

```bash
git pull --ff-only
./scripts/bootstrap.sh
```

```powershell
git pull --ff-only
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
```

Restart Pi after bootstrapping so package and resource changes load.

## Validate changes

```bash
npm run check
```

The Claude bridge has a separate live end-to-end test in `extensions/claude-bridge`; it requires Claude Code cross-session tools and is not part of the default check.
