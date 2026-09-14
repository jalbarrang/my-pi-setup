import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadConfig } from "./config.ts";
import { registerContextFiles } from "./context-files.ts";
import { registerSkills } from "./skills.ts";

/**
 * Adds `@path` imports and `` !`cmd` `` dynamic context to Pi's agentic Markdown.
 *
 * Scope follows the Claude Code model, with one deliberate difference:
 * context files support imports only, never shell execution, because Pi loads
 * them before the project trust decision.
 */
export default function piMarkdownContext(pi: ExtensionAPI) {
	const config = loadConfig();

	if (config.imports) registerContextFiles(pi, config);
	if (config.imports || config.shellExecution !== "never") registerSkills(pi, config);

	pi.registerCommand("markdown-context", {
		description: "Show pi-markdown-context configuration and status",
		handler: async (_args, ctx) => {
			const lines = [
				`config: ${getConfigPath()}`,
				`imports: ${config.imports}`,
				`shellExecution: ${config.shellExecution}`,
				`maxImportDepth: ${config.maxImportDepth}`,
				`shellTimeoutMs: ${config.shellTimeoutMs}`,
				`projectTrusted: ${ctx.isProjectTrusted()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
