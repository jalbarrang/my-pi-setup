import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pmc-test-"));
mkdirSync(join(root, "docs"), { recursive: true });
mkdirSync(join(root, "deep"), { recursive: true });
writeFileSync(join(root, "docs", "arch.md"), "Architecture body.\n\nSee @../deep/nested.md\n");
writeFileSync(join(root, "deep", "nested.md"), "Nested body.\n");
writeFileSync(join(root, "cycle-a.md"), "A -> @cycle-b.md\n");
writeFileSync(join(root, "cycle-b.md"), "B -> @cycle-a.md\n");

const failures = [];
const check = (name, condition, detail) => {
	if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const { splitFencedCode, mapOutsideInlineCode, stripFrontmatter } = await import(
	"../markdown.ts"
);
const { createImportState, expandImports } = await import(
	"../imports.ts"
);
const { expandShellCommands } = await import(
	"../shell.ts"
);
const { expandMarkdown } = await import("../expand.ts");
const { loadConfig } = await import("../config.ts");

// --- markdown scanning ---
const doc = "before\n```\n@code/inside.md\n!`echo hi`\n```\n@real.md and `@span.md`\ntail\n";
const chunks = splitFencedCode(doc);
check("reassembles losslessly", chunks.map((c) => c.text).join("") === doc);
check("finds one code chunk", chunks.filter((c) => c.code).length === 1);

// --- imports ---
const config = { ...loadConfig(), imports: true };
const state = createImportState(config, root, true);
const expanded = expandImports("Top\n@docs/arch.md\nCode: `@docs/arch.md`\n```\n@docs/arch.md\n```\n", root, state);
check("imports expand", expanded.includes("Architecture body."), expanded.slice(0, 200));
check("recursive import expands", expanded.includes("Nested body."));
check("inline code not expanded", expanded.includes("`@docs/arch.md`"));
check("fenced code not expanded", expanded.includes("```\n@docs/arch.md\n```"));
check("no diagnostics on success", state.diagnostics.length === 0, state.diagnostics.join("; "));

const cycleState = createImportState(config, root, true);
const cycle = expandImports("@cycle-a.md\n", root, cycleState);
check("cycle terminates", cycle.includes("already included"), cycle.slice(0, 200));
check("cycle caught", cycleState.visited.size >= 2);

writeFileSync(join(tmpdir(), "outside.md"), "outside body\n");
const missingState = createImportState(config, root, true);
check("missing file left literal", expandImports("@nope/missing.md\n", root, missingState) === "@nope/missing.md\n");

// --- trust gating ---
const untrustedState = createImportState(config, root, false);
const outside = expandImports(`@${join(tmpdir(), "outside.md")}\n`, root, untrustedState);
check("external import blocked when untrusted", outside.startsWith("@/"), outside.slice(0, 80));
check("blocked import reports diagnostic", untrustedState.diagnostics.some((d) => d.includes("not trusted")));

// --- shell ---
const executed = [];
const fakePi = {
	exec: async (command, args, options) => {
		executed.push({ command, args, cwd: options.cwd });
		return { stdout: `OUT(${args[1]})`, stderr: "", code: 0, killed: false };
	},
};

const shellDoc = "Inline !`echo one` here\n\n```!\necho two\necho three\n```\n";
const shellOut = await expandShellCommands(fakePi, shellDoc, { allowed: true, cwd: root, timeoutMs: 1000 });
check("inline command ran", shellOut.includes("OUT(echo one)"), shellOut);
check("fenced command ran", shellOut.includes("OUT(echo two\necho three)"), shellOut);
check("bash -lc used", executed.every((e) => e.command === "bash" && e.args[0] === "-lc"));
check("cwd forwarded", executed.every((e) => e.cwd === root));

const disabled = await expandShellCommands(fakePi, "!`echo nope`\n", { allowed: false, cwd: root, timeoutMs: 1000 });
check("disabled placeholder", disabled.includes("disabled by policy"), disabled);

const noRescan = await expandShellCommands(
	{ exec: async () => ({ stdout: "!`echo again`", stderr: "", code: 0, killed: false }) },
	"!`echo first`\n",
	{ allowed: true, cwd: root, timeoutMs: 1000 },
);
check("output not re-scanned", noRescan === "!`echo again`\n", JSON.stringify(noRescan));

// --- ordering: imports must not execute shell ---
writeFileSync(join(root, "evil.md"), "!`echo pwned`\n");
const orderExecuted = [];
const orderOut = await expandMarkdown(
	{ exec: async (_c, args) => { orderExecuted.push(args[1]); return { stdout: "ran", stderr: "", code: 0, killed: false }; } },
	config,
	{ markdown: "@evil.md\n", baseDir: root, cwd: root, projectTrusted: true, shell: "execute" },
);
check("imported content never executes", !orderExecuted.some((c) => c.includes("pwned")), orderExecuted.join("; "));
check("imported shell text preserved literally", orderOut.text.includes("!`echo pwned`"), orderOut.text);

// --- frontmatter ---
const fm = stripFrontmatter("---\nname: x\ndescription: y\n---\n\nBody here\n");
check("frontmatter stripped", fm.trim() === "Body here", JSON.stringify(fm));

console.log(failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES:\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
