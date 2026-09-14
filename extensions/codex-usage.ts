import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Adds /codex-usage, backed by the authenticated Codex CLI app-server. */

const ENTRY_TYPE = "codex-plan-usage";
const REQUEST_TIMEOUT_MS = 20_000;
const BAR_WIDTH = 20;

type RateLimitWindow = {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
};

type CreditsSnapshot = {
	hasCredits: boolean;
	unlimited: boolean;
	balance: string | null;
};

type SpendControlLimit = {
	limit: string;
	used: string;
	remainingPercent: number;
	resetsAt: number;
};

type RateLimitBucket = {
	id: string;
	name: string | null;
	planType: string | null;
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	credits: CreditsSnapshot | null;
	individualLimit: SpendControlLimit | null;
	spendControlReached: boolean | null;
	rateLimitReachedType: string | null;
};

type UsageCardData = {
	fetchedAt: number;
	buckets: RateLimitBucket[];
	resetCreditsAvailable: number | null;
};

type ThemeColor = "error" | "warning" | "success";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function parseWindow(value: unknown): RateLimitWindow | null {
	if (!isRecord(value)) return null;

	const usedPercent = nullableNumber(value.usedPercent);
	if (usedPercent === null) return null;

	return {
		usedPercent,
		windowDurationMins: nullableNumber(value.windowDurationMins),
		resetsAt: nullableNumber(value.resetsAt),
	};
}

function parseCredits(value: unknown): CreditsSnapshot | null {
	if (!isRecord(value) || typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") {
		return null;
	}

	return {
		hasCredits: value.hasCredits,
		unlimited: value.unlimited,
		balance: nullableString(value.balance),
	};
}

function parseSpendControl(value: unknown): SpendControlLimit | null {
	if (!isRecord(value)) return null;

	const limit = nullableString(value.limit);
	const used = nullableString(value.used);
	const remainingPercent = nullableNumber(value.remainingPercent);
	const resetsAt = nullableNumber(value.resetsAt);
	if (limit === null || used === null || remainingPercent === null || resetsAt === null) return null;

	return { limit, used, remainingPercent, resetsAt };
}

function parseBucket(value: unknown, fallbackId: string): RateLimitBucket | null {
	if (!isRecord(value)) return null;

	const primary = parseWindow(value.primary);
	const secondary = parseWindow(value.secondary);
	const credits = parseCredits(value.credits);
	const individualLimit = parseSpendControl(value.individualLimit);
	if (!primary && !secondary && !credits && !individualLimit) return null;

	return {
		id: nullableString(value.limitId) ?? fallbackId,
		name: nullableString(value.limitName),
		planType: nullableString(value.planType),
		primary,
		secondary,
		credits,
		individualLimit,
		spendControlReached: nullableBoolean(value.spendControlReached),
		rateLimitReachedType: nullableString(value.rateLimitReachedType),
	};
}

function parseUsageResponse(value: unknown): UsageCardData {
	if (!isRecord(value)) throw new Error("Codex returned an invalid usage response.");

	const buckets: RateLimitBucket[] = [];
	if (isRecord(value.rateLimitsByLimitId)) {
		for (const [id, bucketValue] of Object.entries(value.rateLimitsByLimitId)) {
			const bucket = parseBucket(bucketValue, id);
			if (bucket) buckets.push(bucket);
		}
	}

	if (buckets.length === 0) {
		const bucket = parseBucket(value.rateLimits, "codex");
		if (bucket) buckets.push(bucket);
	}

	if (buckets.length === 0) throw new Error("Codex did not return plan usage data.");

	const resetCreditsAvailable = isRecord(value.rateLimitResetCredits)
		? nullableNumber(value.rateLimitResetCredits.availableCount)
		: null;

	return {
		fetchedAt: Date.now(),
		buckets,
		resetCreditsAvailable,
	};
}

function rpcErrorMessage(value: unknown): string {
	if (isRecord(value) && typeof value.message === "string") return value.message;
	return "Codex could not retrieve plan usage.";
}

/** Fetches the authenticated Codex plan limits through Codex's local app-server protocol. */
function fetchCodexUsage(): Promise<UsageCardData> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let settled = false;
		let stdoutBuffer = "";
		let stderr = "";

		const finish = (result: UsageCardData | Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.stdin.end();
			child.kill();

			if (result instanceof Error) reject(result);
			else resolve(result);
		};

		const send = (message: unknown) => {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		};

		const handleLine = (line: string) => {
			if (!line.trim()) return;

			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}

			if (!isRecord(message)) return;

			if (message.id === 1) {
				if (message.error) {
					finish(new Error(rpcErrorMessage(message.error)));
					return;
				}

				send({ method: "initialized" });
				send({ method: "account/rateLimits/read", id: 2 });
				return;
			}

			if (message.id !== 2) return;
			if (message.error) {
				finish(new Error(rpcErrorMessage(message.error)));
				return;
			}

			try {
				finish(parseUsageResponse(message.result));
			} catch (error) {
				finish(error instanceof Error ? error : new Error("Could not parse Codex plan usage."));
			}
		};

		const timeout = setTimeout(() => {
			finish(new Error("Timed out while asking Codex for plan usage."));
		}, REQUEST_TIMEOUT_MS);

		child.on("error", (error) => {
			const message = error.message.includes("ENOENT")
				? "The Codex CLI was not found in PATH."
				: `Could not start the Codex CLI: ${error.message}`;
			finish(new Error(message));
		});

		child.on("exit", (code) => {
			if (settled) return;
			const detail = stderr.trim();
			finish(new Error(detail || `Codex app-server exited before replying (code ${code ?? "unknown"}).`));
		});

		child.stdin.on("error", (error) => {
			if (!settled) finish(new Error(`Could not communicate with Codex: ${error.message}`));
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
		});

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		send({
			method: "initialize",
			id: 1,
			params: {
				clientInfo: {
					name: "pi-codex-usage",
					title: "Pi Codex Usage",
					version: "1.0.0",
				},
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
				},
			},
		});
	});
}

function formatPlanType(planType: string | null): string {
	if (!planType) return "Unknown plan";
	return planType
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function formatDuration(minutes: number): string {
	if (minutes % 10_080 === 0) {
		const weeks = minutes / 10_080;
		return `${weeks} week${weeks === 1 ? "" : "s"}`;
	}
	if (minutes % 1_440 === 0) {
		const days = minutes / 1_440;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	return `${minutes} min`;
}

function formatWindowLabel(window: RateLimitWindow, fallback: string): string {
	if (window.windowDurationMins === 300) return "5-hour window";
	if (window.windowDurationMins === 10_080) return "Weekly window";
	if (window.windowDurationMins !== null) return `${formatDuration(window.windowDurationMins)} window`;
	return fallback;
}

function formatReset(resetsAt: number | null, now = Date.now()): string {
	if (resetsAt === null) return "reset time unavailable";

	const resetMs = resetsAt * 1_000;
	const remainingMs = Math.max(0, resetMs - now);
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (days === 0 && minutes > 0) parts.push(`${minutes}m`);
	const isNow = parts.length === 0;

	const absolute = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(resetMs));

	return isNow ? `resets now (${absolute})` : `resets in ${parts.join(" ")} (${absolute})`;
}

function usageColor(usedPercent: number): ThemeColor {
	if (usedPercent >= 90) return "error";
	if (usedPercent >= 70) return "warning";
	return "success";
}

function buildBar(usedPercent: number): string {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as UsageCardData;
		const firstPlan = data.buckets.find((bucket) => bucket.planType)?.planType ?? null;
		const lines = [
			theme.fg("accent", theme.bold("Codex plan usage")) + theme.fg("muted", ` · ${formatPlanType(firstPlan)}`),
		];

		for (const [bucketIndex, bucket] of data.buckets.entries()) {
			if (bucketIndex > 0) lines.push("");
			if (data.buckets.length > 1) {
				const label = bucket.name ?? bucket.id;
				lines.push(theme.fg("text", theme.bold(label)));
			}

			const windows = [
				{ value: bucket.primary, fallback: "Primary window" },
				{ value: bucket.secondary, fallback: "Secondary window" },
			];

			for (const { value: window, fallback } of windows) {
				if (!window) continue;
				const percent = formatPercent(window.usedPercent);
				const remaining = formatPercent(Math.max(0, 100 - window.usedPercent));
				lines.push(
					`${theme.fg("muted", formatWindowLabel(window, fallback))}\n` +
					`${theme.fg(usageColor(window.usedPercent), buildBar(window.usedPercent))} ` +
					`${theme.bold(`${percent}% used`)}${theme.fg("dim", ` · ${remaining}% left · ${formatReset(window.resetsAt)}`)}`,
				);
			}

			if (bucket.credits) {
				const hasUsableCredits = bucket.credits.unlimited || bucket.credits.hasCredits;
				const creditText = bucket.credits.unlimited
					? "unlimited"
					: bucket.credits.hasCredits
						? bucket.credits.balance ?? "available"
						: "none";
				lines.push(theme.fg("muted", "Extra credits: ") + theme.fg(hasUsableCredits ? "success" : "dim", creditText));
			}

			if (bucket.individualLimit) {
				const limit = bucket.individualLimit;
				lines.push(
					theme.fg("muted", "Spend control: ") +
					`${limit.used} / ${limit.limit}` +
					theme.fg("dim", ` · ${formatPercent(limit.remainingPercent)}% left · ${formatReset(limit.resetsAt)}`),
				);
			}

			if (bucket.spendControlReached || bucket.rateLimitReachedType) {
				lines.push(theme.fg("error", `Limit reached${bucket.rateLimitReachedType ? `: ${bucket.rateLimitReachedType}` : ""}`));
			}
		}

		if (data.resetCreditsAvailable !== null && data.resetCreditsAvailable > 0) {
			lines.push(theme.fg("muted", `Rate-limit reset credits: ${data.resetCreditsAvailable}`));
		}

		const fetchedAt = new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date(data.fetchedAt));
		lines.push(theme.fg("dim", `Updated ${fetchedAt}`));

		return new Text(lines.join("\n"), 1, 0);
	});

	pi.registerCommand("codex-usage", {
		description: "Show Codex plan usage and reset times",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("codex-usage", ctx.ui.theme.fg("muted", "Fetching Codex usage…"));
			try {
				const usage = await fetchCodexUsage();
				pi.appendEntry(ENTRY_TYPE, usage);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Could not retrieve Codex plan usage.";
				ctx.ui.notify(message, "error");
			} finally {
				ctx.ui.setStatus("codex-usage", undefined);
			}
		},
	});
}
