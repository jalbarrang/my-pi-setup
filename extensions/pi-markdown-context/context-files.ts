import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MarkdownContextConfig } from "./config.ts";
import { expandMarkdown } from "./expand.ts";

/**
 * Expands `@path` references in loaded AGENTS.md and CLAUDE.md files.
 *
 * Pi builds the prompt string before `before_agent_start` fires and does not
 * export `buildSystemPrompt`, so the expanded text is spliced back in by
 * replacing the exact `<project_instructions>` block for each file.
 *
 * Shell commands never run here: context files load before project trust is
 * resolved, so executing them would be a remote-code-execution path.
 */
export function registerContextFiles(pi: ExtensionAPI, config: MarkdownContextConfig): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const contextFiles = event.systemPromptOptions?.contextFiles;
		if (!contextFiles || contextFiles.length === 0) return undefined;

		let systemPrompt = event.systemPrompt;
		const diagnostics: string[] = [];

		for (const file of contextFiles) {
			// Cheap guard so files without references skip all work.
			if (!file.content.includes("@")) continue;

			const original = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`;
			if (!systemPrompt.includes(original)) continue;

			const expanded = await expandMarkdown(pi, config, {
				markdown: file.content,
				baseDir: dirname(file.path),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				shell: "ignore",
			});

			diagnostics.push(...expanded.diagnostics);
			if (expanded.text === file.content) continue;

			systemPrompt = systemPrompt.replace(
				original,
				`<project_instructions path="${file.path}">\n${expanded.text}\n</project_instructions>`,
			);
		}

		if (diagnostics.length > 0 && ctx.hasUI) {
			const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
			ctx.ui.notify(`markdown-context: ${diagnostics[0]}${suffix}`, "warning");
		}

		if (systemPrompt === event.systemPrompt) return undefined;
		return { systemPrompt };
	});
}
