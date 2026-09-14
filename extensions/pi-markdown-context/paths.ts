import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Expands `~`, then resolves absolute and relative specs against a base directory. */
export function resolveSpec(spec: string, baseDir: string): string {
	const expanded = spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec;
	return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** True when `child` is `parent` or lives underneath it. */
export function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Strips a leading `@` that some models add to path arguments. */
export function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}
