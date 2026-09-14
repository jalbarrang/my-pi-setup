import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pmc-hooks-"));
const skillDir = join(root, ".pi", "skills", "demo");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(root, "note.md"), "Note body line.\n");
writeFileSync(join(skillDir, "ref.md"), "Reference body.\n");

const skillPath = join(skillDir, "SKILL.md");
writeFileSync(
	skillPath,
	"---\nname: demo\ndescription: demo skill\n---\n\n## Diff\n\n!`echo live`\n\n## Ref\n\n@ref.md\n",
);

const failures = [];
const check = (name, condition, detail) => {
	if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const { registerContextFiles } = await import(
	"../context-files.ts"
);
const { registerSkills } = await import("../skills.ts");

const config = {
	imports: true,
	shellExecution: "trusted-only",
	maxImportDepth: 4,
	maxFileChars: 200_000,
	maxTotalImportChars: 400_000,
	shellTimeoutMs: 120_000,
};

const commands = [
	{
		name: "skill:demo",
		description: "demo skill",
		source: "skill",
		sourceInfo: { path: skillPath, source: "skills", scope: "project", origin: "top-level", baseDir: skillDir },
	},
];

const execCalls = [];
const handlers = new Map();
const pi = {
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	getCommands: () => commands,
	exec: async (_command, args) => {
		execCalls.push(args[1]);
		return { stdout: "LIVE-OUTPUT", stderr: "", code: 0, killed: false };
	},
};

const makeCtx = (trusted) => ({
	cwd: root,
	isProjectTrusted: () => trusted,
	hasUI: false,
	signal: undefined,
	ui: { notify: () => {} },
});

registerContextFiles(pi, config);
registerSkills(pi, config);

// --- context files seam ---
const contextContent = "Project rules.\n\nSee @note.md\n";
const contextPath = join(root, "AGENTS.md");
const systemPrompt = `HEAD\n<project_instructions path="${contextPath}">\n${contextContent}\n</project_instructions>\nTAIL`;
const beforeAgentStart = handlers.get("before_agent_start")[0];
const result = await beforeAgentStart(
	{ systemPrompt, systemPromptOptions: { contextFiles: [{ path: contextPath, content: contextContent }] } },
	makeCtx(true),
);

check("context file returns systemPrompt", typeof result?.systemPrompt === "string");
check("context import expanded", result.systemPrompt.includes("Note body line."), result.systemPrompt);
check("context wrapper preserved", result.systemPrompt.includes(`<project_instructions path="${contextPath}">`));
check("context shell not executed", execCalls.length === 0, execCalls.join("; "));
check("head/tail preserved", result.systemPrompt.startsWith("HEAD") && result.systemPrompt.endsWith("TAIL"));

const untouched = await beforeAgentStart(
	{ systemPrompt: "no context files here", systemPromptOptions: { contextFiles: [] } },
	makeCtx(true),
);
check("no-op when no context files", untouched === undefined);

// --- skills: explicit /skill: ---
const inputHandler = handlers.get("input")[0];
const trustedSkill = await inputHandler({ source: "interactive", text: "/skill:demo extra args" }, makeCtx(true));

check("skill transform action", trustedSkill?.action === "transform", JSON.stringify(trustedSkill));
check("skill block wrapper", trustedSkill.text.startsWith(`<skill name="demo" location="${skillPath}">`));
check("skill frontmatter stripped", !trustedSkill.text.includes("description: demo skill"));
check("skill command executed", trustedSkill.text.includes("LIVE-OUTPUT"), trustedSkill.text);
check("skill import expanded", trustedSkill.text.includes("Reference body."), trustedSkill.text);
check("skill args appended", trustedSkill.text.endsWith("extra args"), trustedSkill.text);

execCalls.length = 0;
const untrustedSkill = await inputHandler({ source: "interactive", text: "/skill:demo" }, makeCtx(false));
check("untrusted project skill blocked", untrustedSkill.text.includes("disabled by policy"), untrustedSkill.text);
check("untrusted project skill has no exec", execCalls.length === 0, execCalls.join("; "));

const passthrough = await inputHandler({ source: "interactive", text: "just a normal prompt" }, makeCtx(true));
check("normal prompt passes through", passthrough?.action === "continue");
const unknownSkill = await inputHandler({ source: "interactive", text: "/skill:nope" }, makeCtx(true));
check("unknown skill passes through", unknownSkill?.action === "continue");

// --- skills: auto-invoked via read tool ---
const toolResult = handlers.get("tool_result")[0];
const readRaw = "---\nname: demo\n---\n\n!`echo live`\n\n@ref.md\n";
const readResult = await toolResult(
	{
		toolName: "read",
		input: { path: ".pi/skills/demo/SKILL.md" },
		content: [{ type: "text", text: readRaw }],
	},
	makeCtx(true),
);
check("read seam patches content", readResult?.content?.[0]?.text?.includes("LIVE-OUTPUT"), JSON.stringify(readResult));
check("read seam expands imports", readResult.content[0].text.includes("Reference body."));

const unrelatedRead = await toolResult(
	{ toolName: "read", input: { path: "note.md" }, content: [{ type: "text", text: "@note.md" }] },
	makeCtx(true),
);
check("unrelated read untouched", unrelatedRead === undefined);

console.log(failures.length === 0 ? "ALL HOOK CHECKS PASSED" : `FAILURES:\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
