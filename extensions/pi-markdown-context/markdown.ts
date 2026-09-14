export interface FencedChunk {
	readonly text: string;
	/** True for fenced code blocks, which imports and inline commands must skip. */
	readonly code: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/**
 * Splits markdown into fenced-code and non-code chunks in source order.
 * Chunks concatenate back into the original string.
 */
export function splitFencedCode(markdown: string): FencedChunk[] {
	const chunks: FencedChunk[] = [];
	let fence: string | undefined;
	let buffer = "";

	const flush = (code: boolean): void => {
		if (buffer.length === 0) return;
		chunks.push({ text: buffer, code });
		buffer = "";
	};

	// Keep line terminators so chunks reassemble losslessly.
	for (const line of markdown.split(/(?<=\n)/)) {
		if (fence === undefined) {
			const opener = FENCE_OPEN.exec(line)?.[1];
			if (opener) {
				flush(false);
				fence = opener;
				buffer = line;
				continue;
			}
			buffer += line;
			continue;
		}

		buffer += line;
		if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}$`).test(line.trimEnd())) {
			fence = undefined;
			flush(true);
		}
	}

	flush(fence !== undefined);
	return chunks;
}

/**
 * Applies `transform` to the parts of a single line that are not inline code spans.
 * Inline code is preserved verbatim so `@mentions` and `$vars` inside backticks stay literal.
 */
export function mapOutsideInlineCode(line: string, transform: (text: string) => string): string {
	let result = "";
	let cursor = 0;

	for (const match of line.matchAll(INLINE_CODE)) {
		result += transform(line.slice(cursor, match.index)) + match[0];
		cursor = match.index + match[0].length;
	}

	return result + transform(line.slice(cursor));
}

/** Removes leading YAML frontmatter, returning the body unchanged when absent. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	if (end === -1) return content;
	const after = content.indexOf("\n", end + 1);
	return after === -1 ? "" : content.slice(after + 1);
}
