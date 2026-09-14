import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MESSAGES = [
	"Brewing ideas…",
	"Consulting the rubber duck…",
	"Connecting tiny dots…",
	"Counting invisible beans…",
	"Herding bits…",
	"Pondering possibilities…",
	"Reading the tea leaves…",
	"Rolling for insight…",
	"Summoning semicolons…",
	"Teaching electrons new tricks…",
	"Untangling thoughts…",
	"Warming up neurons…",
	"Chasing edge cases…",
	"Making it sparkle…",
	"Asking the void nicely…",
	"Aligning the stars…",
] as const;

const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export default function (pi: ExtensionAPI) {
	let previousMessageIndex = -1;

	const showNextMessage = (ctx: ExtensionContext) => {
		let nextIndex = Math.floor(Math.random() * MESSAGES.length);
		if (nextIndex === previousMessageIndex) {
			nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (MESSAGES.length - 1))) % MESSAGES.length;
		}

		previousMessageIndex = nextIndex;
		ctx.ui.setWorkingMessage(ctx.ui.theme.fg("muted", MESSAGES[nextIndex]!));
	};

	const applyWhimsy = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 90,
		});
		showNextMessage(ctx);
	};

	const restoreDefault = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
	};

	pi.on("session_start", (_event, ctx) => {
		applyWhimsy(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode === "tui") showNextMessage(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		restoreDefault(ctx);
	});
}
