import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commentsIntroduced,
	deriveArtifactMetrics,
	runValidation,
	touchedFiles,
} from "./artifacts";

let repo: string;

function sh(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!r.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "trpi-evals-"));
	sh(repo, "init", "-b", "main");
	sh(repo, "config", "user.email", "t@thinkrail.test");
	sh(repo, "config", "user.name", "test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "main.ts"), "export const a = 1;\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-m", "trial baseline");
});

test("touched files cover edits, new files, and files in new directories", () => {
	writeFileSync(join(repo, "main.ts"), "export const a = 2;\n");
	mkdirSync(join(repo, "lib"));
	writeFileSync(join(repo, "lib", "util.ts"), "export const b = 1;\n");
	const metrics = deriveArtifactMetrics(repo, "HEAD");
	expect(metrics.filesTouched).toEqual(["lib/util.ts", "main.ts"]);
});

test("counts added comment lines by language, ignoring shebangs and non-code files", () => {
	writeFileSync(join(repo, "main.ts"), "// explains itself\nexport const a = 1;\n");
	writeFileSync(join(repo, "run.py"), "#!/usr/bin/env python\n# a real comment\nx = 1\n");
	writeFileSync(join(repo, "notes.md"), "# a heading, not a comment\n");
	sh(repo, "add", "-A");
	expect(commentsIntroduced(repo, "HEAD")).toBe(2);
});

test("a clean workspace touches nothing", () => {
	expect(touchedFiles(repo, "HEAD")).toEqual([]);
	expect(commentsIntroduced(repo, "HEAD")).toBe(0);
});

test("git failures throw loudly instead of reporting clean metrics", () => {
	expect(() => touchedFiles(repo, "no-such-ref")).toThrow(/no-such-ref/);
	expect(() => deriveArtifactMetrics(join(tmpdir(), "definitely-not-a-repo"), "HEAD")).toThrow();
});

test("validations report pass/fail with exit codes", () => {
	const pass = runValidation(repo, { name: "ok", command: "exit 0" });
	const fail = runValidation(repo, { name: "broken", command: "exit 3" });
	expect(pass).toEqual({ name: "ok", command: "exit 0", pass: true, exitCode: 0 });
	expect(fail.pass).toBe(false);
	expect(fail.exitCode).toBe(3);
});
