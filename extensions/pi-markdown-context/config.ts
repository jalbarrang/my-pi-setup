import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ShellExecution = "trusted-only" | "always" | "never";

export interface MarkdownContextConfig {
	/** Expand `@path` references in context files and skills. */
	imports: boolean;
	/** When `` !`cmd` `` inside a skill may run. */
	shellExecution: ShellExecution;
	/** Maximum recursive import hops. */
	maxImportDepth: number;
	/** Maximum characters read from a single imported file. */
	maxFileChars: number;
	/** Total character budget for all imports in one document. */
	maxTotalImportChars: number;
	/** Per-command timeout for `` !`cmd` ``. */
	shellTimeoutMs: number;
}

const DEFAULTS: MarkdownContextConfig = {
	imports: true,
	shellExecution: "trusted-only",
	maxImportDepth: 4,
	maxFileChars: 200_000,
	maxTotalImportChars: 400_000,
	shellTimeoutMs: 120_000,
};

/** Config file location, overridable with PI_MARKDOWN_CONTEXT_CONFIG. */
export function getConfigPath(): string {
	return process.env.PI_MARKDOWN_CONTEXT_CONFIG ?? join(homedir(), ".pi", "agent", "pi-markdown-context.json");
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function readShellExecution(value: unknown, fallback: ShellExecution): ShellExecution {
	return value === "trusted-only" || value === "always" || value === "never" ? value : fallback;
}

/**
 * Loads the config file. A missing or malformed file falls back to defaults
 * rather than failing the extension.
 */
export function loadConfig(): MarkdownContextConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getConfigPath(), "utf8"));
	} catch {
		return { ...DEFAULTS };
	}
	if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };

	const input = parsed as Record<string, unknown>;
	return {
		imports: readBoolean(input.imports, DEFAULTS.imports),
		shellExecution: readShellExecution(input.shellExecution, DEFAULTS.shellExecution),
		maxImportDepth: readInt(input.maxImportDepth, DEFAULTS.maxImportDepth, 0, 16),
		maxFileChars: readInt(input.maxFileChars, DEFAULTS.maxFileChars, 1_000, 5_000_000),
		maxTotalImportChars: readInt(input.maxTotalImportChars, DEFAULTS.maxTotalImportChars, 1_000, 20_000_000),
		shellTimeoutMs: readInt(input.shellTimeoutMs, DEFAULTS.shellTimeoutMs, 1_000, 600_000),
	};
}

export { DEFAULTS as DEFAULT_MARKDOWN_CONTEXT_CONFIG };
