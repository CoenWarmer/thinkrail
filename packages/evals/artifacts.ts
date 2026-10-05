import type { ArtifactMetrics, ValidationResult } from "./schemas";

export type ValidationSpec = {
	name: string;
	command: string;
	timeoutMs?: number;
};

const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

const LINE_COMMENT_PREFIXES: Record<string, string[]> = {
	ts: ["//", "/*", "*"],
	tsx: ["//", "/*", "*"],
	js: ["//", "/*", "*"],
	jsx: ["//", "/*", "*"],
	mjs: ["//", "/*", "*"],
	cjs: ["//", "/*", "*"],
	java: ["//", "/*", "*"],
	c: ["//", "/*", "*"],
	h: ["//", "/*", "*"],
	cpp: ["//", "/*", "*"],
	cs: ["//", "/*", "*"],
	go: ["//", "/*", "*"],
	rs: ["//", "/*", "*"],
	swift: ["//", "/*", "*"],
	kt: ["//", "/*", "*"],
	css: ["/*", "*"],
	scss: ["//", "/*", "*"],
	py: ["#"],
	rb: ["#"],
	sh: ["#"],
	bash: ["#"],
	yaml: ["#"],
	yml: ["#"],
	toml: ["#"],
	sql: ["--"],
	lua: ["--"],
};

import { git } from "./gitRun";

export function deriveArtifactMetrics(
	cwd: string,
	baseRef: string,
	validations: readonly ValidationSpec[] = [],
): ArtifactMetrics {
	git(cwd, ["add", "-A"]);
	return {
		filesTouched: touchedFiles(cwd, baseRef),
		commentsIntroduced: commentsIntroduced(cwd, baseRef),
		validations: validations.map((spec) => runValidation(cwd, spec)),
	};
}

export function touchedFiles(cwd: string, baseRef: string): string[] {
	return git(cwd, ["diff", "--name-only", "-z", baseRef]).split("\0").filter(Boolean).sort();
}

export function commentsIntroduced(cwd: string, baseRef: string): number {
	const diff = git(cwd, ["diff", "-U0", baseRef]);
	let prefixes: string[] | null = null;
	let count = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) {
			const extension = line.split(".").pop()?.trim() ?? "";
			prefixes = LINE_COMMENT_PREFIXES[extension] ?? null;
			continue;
		}
		if (!prefixes || !line.startsWith("+") || line.startsWith("+++")) continue;
		const added = line.slice(1).trimStart();
		if (added.startsWith("#!")) continue;
		if (prefixes.some((prefix) => added.startsWith(prefix))) count += 1;
	}
	return count;
}

export function runValidation(cwd: string, spec: ValidationSpec): ValidationResult {
	try {
		const result = Bun.spawnSync(["sh", "-c", spec.command], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			timeout: spec.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
		});
		return {
			name: spec.name,
			command: spec.command,
			pass: result.success,
			exitCode: result.exitCode,
		};
	} catch {
		return { name: spec.name, command: spec.command, pass: false, exitCode: null };
	}
}
