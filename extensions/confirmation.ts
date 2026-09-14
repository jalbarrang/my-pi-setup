import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type ConfirmationAnswer = "yes" | "no" | "alternative" | "cancelled";

interface ConfirmationDetails {
	question: string;
	answer: ConfirmationAnswer;
	alternative?: string;
}

const ConfirmationParams = Type.Object({
	question: Type.String({ description: "What you want the user to confirm" }),
});

const OPTIONS = ["Yes", "No", "Tell pi what to do instead"];

export default function confirmation(pi: ExtensionAPI) {
	pi.registerTool({
		name: "confirm",
		label: "Confirmation",
		description:
			"Ask the user for a decision when you need confirmation before proceeding. Use this tool when you are about to do something destructive, irreversible, risky, expensive, or outside the original request; when you need approval or permission; when requirements are ambiguous and the next step would be costly to undo; or whenever the user must choose between continuing and changing course. The user answers Yes (proceed), No (stop), or gives alternative instructions telling pi what to do instead.",
		promptSnippet:
			"Ask for yes/no/redirect confirmation before destructive, irreversible, risky, or ambiguous actions",
		promptGuidelines: [
			"Use confirm before destructive or irreversible actions (deleting, overwriting, force-pushing, resetting, running migrations, publishing, spending money, sending messages on the user's behalf) and whenever you need approval or permission.",
			"Use confirm when the request is ambiguous or underspecified and guessing wrong would be costly, instead of assuming and proceeding.",
			"Use confirm instead of asking whether to proceed in plain text, so the user gets Yes, No, and Tell pi what to do instead options.",
			"Do not use confirm for trivial, reversible, or already-authorized steps; reserve it for decisions that really belong to the user.",
		],
		parameters: ConfirmationParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("Confirmation requires an interactive pi UI.");
			}

			const choice = await ctx.ui.select(
				`Confirmation requested: ${params.question}`,
				OPTIONS,
				{ signal },
			);

			if (choice === "Yes") {
				return result(params.question, { answer: "yes" }, "User selected Yes. Proceed.");
			}

			if (choice === "No") {
				return result(
					params.question,
					{ answer: "no" },
					"User selected No. Do not proceed with the proposed action.",
					true,
				);
			}

			if (choice === "Tell pi what to do instead") {
				const alternative = (await ctx.ui.input(
					"What should pi do instead?",
					"Describe the alternative instruction",
					{ signal },
				))?.trim();

				if (alternative) {
					return result(
						params.question,
						{ answer: "alternative", alternative },
						`User said to do this instead: ${alternative}`,
					);
				}
			}

			return result(
				params.question,
				{ answer: "cancelled" },
				"User cancelled the confirmation. Do not proceed until the user gives another instruction.",
				true,
			);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("confirm ")) + theme.fg("muted", args.question),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ConfirmationDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			switch (details.answer) {
				case "yes":
					return new Text(theme.fg("success", "✓ Yes"), 0, 0);
				case "no":
					return new Text(theme.fg("warning", "✗ No"), 0, 0);
				case "alternative":
					return new Text(
						theme.fg("accent", "↪ Instead: ") + theme.fg("muted", details.alternative ?? ""),
						0,
						0,
					);
				default:
					return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
		},
	});
}

function result(
	question: string,
	details: Omit<ConfirmationDetails, "question">,
	text: string,
	terminate = false,
) {
	return {
		content: [{ type: "text" as const, text }],
		details: { question, ...details } satisfies ConfirmationDetails,
		...(terminate ? { terminate: true } : {}),
	};
}
