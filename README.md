# My Pi setup

Portable personal configuration for [Pi](https://pi.dev), designed to stay consistent across multiple machines without committing credentials or runtime state.

## Included

- Shared model, UI, compaction, and package preferences
- `codex-usage`, `commit`, `confirmation`, `copy-all`, `pi-markdown-context`, `pi-mcp`, and `whimsical-working` extensions
- `gh-stack` and `terminal-mermaid` skills
- Optional Context7 configuration
- MCP server configuration (machine-local)
- Per-machine overrides for local package checkouts

### Agentic Markdown

`AGENTS.md` and `CLAUDE.md` support `@path` imports, so shared instructions can
be split across files. Skills support imports plus inline shell substitution for
live context such as the current diff.

Shell substitution runs only for trusted skills. Context files never execute
commands, because Pi loads them before the project trust decision. See
[`extensions/pi-markdown-context/README.md`](extensions/pi-markdown-context/README.md).

### Mermaid diagrams

The `terminal-mermaid` skill teaches agents to emit Mermaid diagrams that fit
Pi's built-in width-limited Unicode renderer.

## Quick start

1. Install Pi and clone this repository anywhere.
2. Run the bootstrap for your platform:

   **macOS/Linux**

   ```bash
   ./scripts/bootstrap.sh
   ```

   **Windows (PowerShell 7+)**

   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
   ```

3. Authenticate providers locally:

   ```text
   pi
   /login
   ```

The bootstrap scripts merge shared settings into `~/.pi/agent/settings.json`, link tracked resources, install extension dependencies, and back up replaced paths. On Windows, directory junctions and file copies are used when symbolic links are unavailable. Set `PI_CODING_AGENT_DIR` to target another Pi config directory.

See [SETUP.md](SETUP.md) for machine-specific packages, credentials, and update steps.

## Repository layout

```text
config/       shared settings and global instructions
extensions/   personal Pi extensions
skills/       agent skills
scripts/      bootstrap and settings merge checks
```

Private Pi state—provider auth, trust decisions, sessions, caches, and API keys—stays outside Git. Global agent instructions are managed by the [dotfiles repository](https://github.com/jalbarrang/dotfiles).
