import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MarkdownContextConfig } from "./config.ts";
import { createImportState, expandImports } from "./imports.ts";
import { expandShellCommands } from "./shell.ts";

export type ShellMode =
	/** Run commands. */
	| "execute"
	/** Replace commands with a policy placeholder instead of running them. */
	| "placeholder"
	/** Leave commands untouched (context files, where shell is never supported). */
	| "ignore";

export interface ExpandRequest {
	readonly markdown: string;
	/** Directory that relative `@path` references and shell commands resolve against. */
	readonly baseDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly shell: ShellMode;
	readonly signal?: AbortSignal;
}

export interface ExpansionResult {
	readonly text: string;
	readonly diagnostics: string[];
}

/**
 * Runs shell substitution first, then imports.
 *
 * The order is deliberate: content pulled in through `@path` is never scanned
 * for `` !`cmd` ``, so a checked-in file cannot trigger command execution.
 */
export async function expandMarkdown(
	pi: ExtensionAPI,
	config: MarkdownContextConfig,
	request: ExpandRequest,
): Promise<ExpansionResult> {
	let text = request.markdown;

	if (request.shell !== "ignore") {
		text = await expandShellCommands(pi, text, {
			allowed: request.shell === "execute",
			cwd: request.baseDir,
			timeoutMs: config.shellTimeoutMs,
			signal: request.signal,
		});
	}

	if (!config.imports) return { text, diagnostics: [] };

	const state = createImportState(config, request.cwd, request.projectTrusted);
	text = expandImports(text, request.baseDir, state);
	return { text, diagnostics: state.diagnostics };
}
