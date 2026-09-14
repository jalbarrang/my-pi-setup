# pi-markdown-context

Adds `@path` imports and `` !`cmd` `` dynamic context to Pi's agentic Markdown files, matching the Claude Code model.

## What it does

| File | `@path` imports | `` !`cmd` `` execution |
|---|---|---|
| `AGENTS.md`, `CLAUDE.md` | yes | **no** (see below) |
| `SKILL.md` | yes | yes, when trusted |

### Imports

```markdown
See @docs/architecture.md and @~/.pi/agent/notes/preferences.md
```

Expanded inline as:

```
<file path="/abs/path/docs/architecture.md">
...
</file>
```

- Recursive, with a depth cap (default 4)
- Cycle-safe
- Skipped inside fenced code blocks and inline code spans
- Size-budgeted per file and per document

### Dynamic context in skills

````markdown
## Current changes

!`git diff HEAD`

## Reference

@references/api-style.md
````

Commands run with `bash -lc` in the skill's directory, with a timeout and output truncation.

## Security model

- **Context files never execute commands.** Pi loads `AGENTS.md`/`CLAUDE.md` *before* the project trust decision, so execution there would let any cloned repo run code.
- **Shell execution is `trusted-only` by default.** User and package skills run commands; project skills require project trust. Blocked commands are replaced with `[shell command execution disabled by policy]`.
- **Context files never process shell syntax at all.** `` !`cmd` `` in `AGENTS.md` stays literal, so nothing in a cloned repo can execute.
- **Imported file content is never scanned for commands.** Shell substitution runs first, so `@path` cannot introduce an execution vector.
- Project context files importing paths outside the project require project trust.

## Config

`~/.pi/agent/pi-markdown-context.json` (override with `PI_MARKDOWN_CONTEXT_CONFIG`):

```json
{
  "imports": true,
  "shellExecution": "trusted-only",
  "maxImportDepth": 4,
  "maxFileChars": 200000,
  "maxTotalImportChars": 400000,
  "shellTimeoutMs": 120000
}
```

`shellExecution` accepts `"trusted-only"`, `"always"`, or `"never"`. Missing or malformed config falls back to defaults.

## Commands

- `/markdown-context` — show config path, effective settings, and project trust.

## Files

- `index.ts` — factory, registers hooks and the command
- `context-files.ts` — `before_agent_start` seam for `AGENTS.md` imports
- `skills.ts` — `input` (explicit `/skill:name`) and `tool_result` (auto-invoked `read`) seams
- `expand.ts` — orchestrates shell-then-imports ordering
- `imports.ts` — recursive `@path` resolution
- `shell.ts` — `` !`cmd` `` execution
- `markdown.ts` — fence-aware and inline-code-aware scanning
- `paths.ts` — path helpers
- `config.ts` — config loading

## Development

```bash
cd extensions/pi-markdown-context
bun test/unit.ts    # scanning, imports, shell, ordering, trust gating
bun test/hooks.ts   # the registered handlers against a fake Pi host
```

Typechecking needs a `paths` mapping for `@earendil-works/pi-coding-agent` pointing at the installed package, since it is not a local dependency.

## Known limits

- `before_agent_start` splices expanded text by replacing the exact `<project_instructions>` block, because Pi builds the prompt before the event and does not export `buildSystemPrompt`.
- Auto-invoked skills are matched by exact resolved `SKILL.md` path, so a symlinked read path may not match.
- Inline commands do not support commands containing backticks.
