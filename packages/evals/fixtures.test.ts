import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractSessionSeed,
	promoteFixture,
	readFixture,
	replayFixtureWorkspace,
} from "./fixtures";
import type { FixtureConfig } from "./schemas";

let root: string;
let repo: string;

function sh(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!r.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "trpi-fixtures-"));
	repo = join(root, "source");
	mkdirSync(repo);
	sh(repo, "init", "-b", "main");
	sh(repo, "config", "user.email", "t@thinkrail.test");
	sh(repo, "config", "user.name", "test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-m", "init");
});

const sessionJsonl = [
	JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w" }),
	JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-x" }),
	JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
	JSON.stringify({ type: "message", message: { role: "user", content: "fix the bug" } }),
	JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
	}),
	JSON.stringify({
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "now add a test" }] },
	}),
	"not json",
].join("\n");

test("extractSessionSeed pulls user turns, last model, and thinking level", () => {
	const seed = extractSessionSeed(sessionJsonl);
	expect(seed.userTurns).toEqual([{ text: "fix the bug" }, { text: "now add a test" }]);
	expect(seed.model).toBe("anthropic/claude-x");
	expect(seed.thinkingLevel).toBe("medium");
});

function headSha(): string {
	return Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
}

const config: FixtureConfig = { model: "anthropic/claude-x", specsAvailable: true };

test("promote + read round-trips a fixture bundle with patch and transcript", () => {
	writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
	const patchPath = join(root, "dirty.patch");
	writeFileSync(patchPath, Bun.spawnSync(["git", "-C", repo, "diff", "HEAD"]).stdout.toString());
	sh(repo, "checkout", "--", "app.ts");
	const transcriptPath = join(root, "session.jsonl");
	writeFileSync(transcriptPath, sessionJsonl);

	const fixture = promoteFixture(join(root, "fixtures"), {
		id: "fx-1",
		source: { sessionId: "s1", cwd: repo },
		workspace: { head: headSha(), branch: "main" },
		patchPath,
		userTurns: [{ text: "fix the bug" }],
		config,
		transcriptPath,
	});
	expect(fixture.workspace.patchFile).toBe("start.patch");
	expect(fixture.reference?.transcriptFile).toBe("reference.jsonl");
	expect(readFixture(join(root, "fixtures"), "fx-1")).toEqual(fixture);
	expect(existsSync(join(root, "fixtures", "fx-1", "start.patch"))).toBe(true);
});

test("promotion refuses an empty replay script and duplicate ids", () => {
	const fixturesRoot = join(root, "fixtures");
	const input = {
		id: "fx-dup",
		source: { sessionId: "s1", cwd: repo },
		workspace: { head: headSha(), branch: "main" },
		userTurns: [{ text: "go" }],
		config,
	};
	expect(() => promoteFixture(fixturesRoot, { ...input, userTurns: [] })).toThrow(/no user turns/);
	promoteFixture(fixturesRoot, input);
	expect(() => promoteFixture(fixturesRoot, input)).toThrow(/already exists/);
});

test("replay reconstructs the start state in a fresh workspace and commits it as baseRef", () => {
	writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
	writeFileSync(join(repo, "wip.ts"), "export const wip = true;\n");
	sh(repo, "add", "-N", "wip.ts");
	const patchPath = join(root, "dirty.patch");
	writeFileSync(patchPath, Bun.spawnSync(["git", "-C", repo, "diff", "HEAD"]).stdout.toString());
	sh(repo, "checkout", "--", "app.ts");

	const fixturesRoot = join(root, "fixtures");
	const fixture = promoteFixture(fixturesRoot, {
		id: "fx-replay",
		source: { sessionId: "s1", cwd: repo },
		workspace: { head: headSha(), branch: "main" },
		patchPath,
		userTurns: [{ text: "go" }],
		config,
	});

	const target = join(root, "trial-1");
	const { baseRef } = replayFixtureWorkspace(fixturesRoot, fixture, target);
	expect(readFileSync(join(target, "app.ts"), "utf8")).toBe("export const a = 2;\n");
	expect(readFileSync(join(target, "wip.ts"), "utf8")).toBe("export const wip = true;\n");
	const status = Bun.spawnSync(["git", "-C", target, "status", "--porcelain"]).stdout.toString();
	expect(status.trim()).toBe("");
	expect(baseRef).toMatch(/^[0-9a-f]{40}$/);
	// disconnected from the user's live repo: no remote for an agent to push to
	const remotes = Bun.spawnSync(["git", "-C", target, "remote"]).stdout.toString();
	expect(remotes.trim()).toBe("");
});

test("replay fails loudly when the source repo is gone", () => {
	const fixturesRoot = join(root, "fixtures");
	const fixture = promoteFixture(fixturesRoot, {
		id: "fx-gone",
		source: { sessionId: "s1", cwd: join(root, "missing") },
		workspace: { head: headSha(), branch: "main" },
		userTurns: [{ text: "go" }],
		config,
	});
	expect(() => replayFixtureWorkspace(fixturesRoot, fixture, join(root, "t"))).toThrow(
		/no longer exists/,
	);
});
