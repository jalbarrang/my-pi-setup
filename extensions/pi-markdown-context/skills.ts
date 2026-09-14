import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownContextConfig } from "./config.ts";
import type { ShellMode } from "./expand.ts";
import { expandMarkdown } from "./expand.ts";
import { stripFrontmatter } from "./markdown.ts";
import { isWithin, stripAtPrefix } from "./paths.ts";

type CommandEntry = ReturnType<ExtensionAPI["getCommands"]>[number];

interface ResolvedSkill {
	readonly name: string;
	readonly path: string;
	readonly baseDir: string;
	/** Project skills live under the working directory and require project trust for shell. */
	readonly isProject: boolean;
}

interface SkillContext {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly signal?: AbortSignal;
}

/**
 * Expands `@path` imports and `` !`cmd` `` commands in skills.
 *
 * Two seams are required because Pi expands `/skill:name` by reading the file
 * directly, while model-invoked skills arrive through the `read` tool.
 */
export function registerSkills(pi: ExtensionAPI, config: MarkdownContextConfig): void {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (typeof event.text !== "string" || !event.text.startsWith("/skill:")) {
			return { action: "continue" };
		}

		const spaceIndex = event.text.indexOf(" ");
		const skillName = spaceIndex === -1 ? event.text.slice(7) : event.text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : event.text.slice(spaceIndex + 1).trim();
		if (skillName.length === 0) return { action: "continue" };

		const skill = findSkillByName(pi, skillName, ctx.cwd);
		if (!skill) return { action: "continue" };

		const context = toSkillContext(ctx);
		const expanded = await expandSkill(pi, skill, config, context);
		if (!expanded) return { action: "continue" };

		notifyDiagnostics(ctx, expanded.diagnostics);

		// Mirrors Pi's own skill block so relative references keep working.
		const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${expanded.text}\n</skill>`;
		return { action: "transform", text: args.length > 0 ? `${block}\n\n${args}` : block };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;

		const rawPath = getStringProperty(event.input, "path");
		if (!rawPath || !/SKILL\.md$/i.test(rawPath)) return undefined;

		const absolutePath = resolve(ctx.cwd, stripAtPrefix(rawPath));
		const skill = findSkillByPath(pi, absolutePath, ctx.cwd);
		if (!skill) return undefined;

		const context = toSkillContext(ctx);
		const content: Array<(typeof event.content)[number]> = [];
		let changed = false;

		for (const part of event.content) {
			if (part.type !== "text") {
				content.push(part);
				continue;
			}

			const expanded = await expandMarkdown(pi, config, {
				markdown: part.text,
				baseDir: skill.baseDir,
				cwd: context.cwd,
				projectTrusted: context.projectTrusted,
				shell: resolveShellMode(skill, context, config),
				signal: context.signal,
			});

			if (expanded.text !== part.text) changed = true;
			notifyDiagnostics(ctx, expanded.diagnostics);
			content.push({ ...part, text: expanded.text });
		}

		if (!changed) return undefined;
		return { content };
	});
}

function toSkillContext(ctx: ExtensionContext): SkillContext {
	return { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), signal: ctx.signal };
}

async function expandSkill(
	pi: ExtensionAPI,
	skill: ResolvedSkill,
	config: MarkdownContextConfig,
	context: SkillContext,
): Promise<{ text: string; diagnostics: string[] } | undefined> {
	let body: string;
	try {
		body = stripFrontmatter(readFileSync(skill.path, "utf8")).trim();
	} catch {
		return undefined;
	}

	return expandMarkdown(pi, config, {
		markdown: body,
		baseDir: skill.baseDir,
		cwd: context.cwd,
		projectTrusted: context.projectTrusted,
		shell: resolveShellMode(skill, context, config),
		signal: context.signal,
	});
}

/**
 * Decides how skill shell placeholders are handled.
 *
 * `trusted-only` lets user and package skills run commands immediately, while
 * project skills require an explicit project trust decision.
 */
function resolveShellMode(
	skill: ResolvedSkill,
	context: SkillContext,
	config: MarkdownContextConfig,
): ShellMode {
	if (config.shellExecution === "never") return "placeholder";
	if (config.shellExecution === "always") return "execute";
	return skill.isProject && !context.projectTrusted ? "placeholder" : "execute";
}

function findSkillByName(pi: ExtensionAPI, name: string, cwd: string): ResolvedSkill | undefined {
	const command = pi.getCommands().find((entry) => entry.source === "skill" && entry.name === `skill:${name}`);
	return command ? toResolvedSkill(command, cwd) : undefined;
}

function findSkillByPath(pi: ExtensionAPI, absolutePath: string, cwd: string): ResolvedSkill | undefined {
	const command = pi.getCommands().find((entry) => {
		if (entry.source !== "skill") return false;
		const path = entry.sourceInfo?.path;
		return typeof path === "string" && resolve(path) === absolutePath;
	});
	return command ? toResolvedSkill(command, cwd) : undefined;
}

function toResolvedSkill(command: CommandEntry, cwd: string): ResolvedSkill | undefined {
	const path = command.sourceInfo?.path;
	if (typeof path !== "string" || path.length === 0) return undefined;

	const absolutePath = resolve(path);
	return {
		name: command.name.replace(/^skill:/, ""),
		path: absolutePath,
		baseDir: resolve(command.sourceInfo?.baseDir ?? dirname(absolutePath)),
		isProject: isWithin(cwd, absolutePath),
	};
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function notifyDiagnostics(ctx: ExtensionContext, diagnostics: readonly string[]): void {
	if (diagnostics.length === 0 || !ctx.hasUI) return;
	const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
	ctx.ui.notify(`markdown-context: ${diagnostics[0]}${suffix}`, "warning");
}
