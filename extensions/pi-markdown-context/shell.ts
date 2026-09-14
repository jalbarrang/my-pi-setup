import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitFencedCode } from "./markdown.ts";

export interface ShellOptions {
	/** False when policy disables execution; commands are replaced with a placeholder. */
	readonly allowed: boolean;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

const DISABLED_PLACEHOLDER = "[shell command execution disabled by policy]";
const EXEC_FENCE = /^ {0,3}```!\s*\n?([\s\S]*?)\n? {0,3}```\s*$/;
const INLINE_COMMAND = /(^|[\s])!`([^`\n]+)`/g;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Replaces `` !`cmd` `` and ` ```! ` blocks with command output.
 *
 * Command output is inserted as literal text and is never re-scanned for more
 * placeholders, so a command cannot trigger further execution.
 */
export async function expandShellCommands(
	pi: ExtensionAPI,
	markdown: string,
	options: ShellOptions,
): Promise<string> {
	const parts: string[] = [];

	for (const chunk of splitFencedCode(markdown)) {
		if (!chunk.code) {
			parts.push(await expandInline(pi, chunk.text, options));
			continue;
		}

		const command = EXEC_FENCE.exec(chunk.text)?.[1]?.trim();
		parts.push(command ? await renderCommand(pi, command, options) : chunk.text);
	}

	return parts.join("");
}

async function expandInline(pi: ExtensionAPI, text: string, options: ShellOptions): Promise<string> {
	const matches = [...text.matchAll(INLINE_COMMAND)];
	if (matches.length === 0) return text;

	let result = "";
	let cursor = 0;

	for (const match of matches) {
		const [full, prefix, command] = match;
		const start = match.index;
		const output = await renderCommand(pi, command.trim(), options);
		result += text.slice(cursor, start) + prefix + output;
		cursor = start + full.length;
	}

	return result + text.slice(cursor);
}

async function renderCommand(pi: ExtensionAPI, command: string, options: ShellOptions): Promise<string> {
	if (command.length === 0) return "";
	if (!options.allowed) return DISABLED_PLACEHOLDER;

	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec("bash", ["-lc", command], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			signal: options.signal,
		});
	} catch (error) {
		return `[command failed to start: ${error instanceof Error ? error.message : String(error)}]`;
	}

	const output = truncate([result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n").trimEnd());

	if (result.killed) return `[command timed out after ${options.timeoutMs}ms]\n${output}`;
	if (result.code === 0) return output.length > 0 ? output : "[no output]";
	return [`[exit ${result.code}]`, output].filter((line) => line.length > 0).join("\n");
}

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} characters]`;
}
