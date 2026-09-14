import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { MarkdownContextConfig } from "./config.ts";
import { mapOutsideInlineCode, splitFencedCode } from "./markdown.ts";
import { isWithin, resolveSpec } from "./paths.ts";

/** `@spec` at a word boundary. Trailing punctuation is split off before resolving. */
const IMPORT_PATTERN = /(^|[\s(])@([^\s`]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"']+$/;

export interface ImportState {
	readonly config: MarkdownContextConfig;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly diagnostics: string[];
	readonly visited: Set<string>;
	budget: number;
}

export function createImportState(
	config: MarkdownContextConfig,
	cwd: string,
	projectTrusted: boolean,
): ImportState {
	return {
		config,
		cwd,
		projectTrusted,
		diagnostics: [],
		visited: new Set(),
		budget: config.maxTotalImportChars,
	};
}

/**
 * Expands `@path` references, recursing into imported files up to `maxImportDepth`.
 *
 * Safety rules:
 * - references inside fenced code blocks and inline code spans are never expanded
 * - a project file importing a path outside the project requires project trust
 * - cycles and repeated files are collapsed
 * - total imported characters are budgeted
 */
export function expandImports(markdown: string, baseDir: string, state: ImportState, depth = 0): string {
	if (depth > state.config.maxImportDepth) return markdown;

	return splitFencedCode(markdown)
		.map((chunk) => (chunk.code ? chunk.text : expandChunk(chunk.text, baseDir, state, depth)))
		.join("");
}

function expandChunk(text: string, baseDir: string, state: ImportState, depth: number): string {
	return text
		.split("\n")
		.map((line) => mapOutsideInlineCode(line, (segment) => expandSegment(segment, baseDir, state, depth)))
		.join("\n");
}

function expandSegment(segment: string, baseDir: string, state: ImportState, depth: number): string {
	if (!segment.includes("@")) return segment;

	return segment.replace(IMPORT_PATTERN, (match, prefix: string, rawSpec: string) => {
		const spec = rawSpec.replace(TRAILING_PUNCTUATION, "");
		const trailing = rawSpec.slice(spec.length);
		if (spec.length === 0) return match;

		const absolutePath = resolveImport(spec, baseDir);
		if (!absolutePath) return match;

		if (!state.projectTrusted && isWithin(state.cwd, baseDir) && !isWithin(state.cwd, absolutePath)) {
			state.diagnostics.push(`skipped external import (project not trusted): ${spec}`);
			return match;
		}

		if (state.visited.has(absolutePath)) return `${prefix}<!-- @${spec}: already included -->${trailing}`;
		if (state.budget <= 0) {
			state.diagnostics.push(`import budget exhausted at: ${spec}`);
			return match;
		}

		const content = readImport(absolutePath, state);
		if (content === undefined) return match;

		state.visited.add(absolutePath);
		const nested = expandImports(content, dirname(absolutePath), state, depth + 1);
		return `${prefix}<file path="${absolutePath}">\n${nested}\n</file>${trailing}`;
	});
}

/** Resolves `spec` against `baseDir`, accepting an implicit `.md` extension. */
function resolveImport(spec: string, baseDir: string): string | undefined {
	const candidate = resolveSpec(spec, baseDir);
	for (const path of [candidate, `${candidate}.md`]) {
		try {
			if (statSync(path).isFile()) return path;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

function readImport(absolutePath: string, state: ImportState): string | undefined {
	let content: string;
	try {
		content = readFileSync(absolutePath, "utf8");
	} catch (error) {
		state.diagnostics.push(`failed to read ${absolutePath}: ${String(error)}`);
		return undefined;
	}

	if (content.length > state.config.maxFileChars) {
		state.diagnostics.push(`truncated large import: ${absolutePath}`);
		content = content.slice(0, state.config.maxFileChars);
	}

	state.budget -= content.length;
	return content;
}
