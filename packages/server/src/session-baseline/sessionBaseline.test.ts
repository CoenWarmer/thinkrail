import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSessionBaseline, readSessionBaseline, sessionBaselineDir } from "./sessionBaseline";

let dataDir: string;
let repo: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function sh(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!r.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-baseline-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	repo = join(dataDir, "repo");
	mkdirSync(repo);
	sh(repo, "init", "-b", "main");
	sh(repo, "config", "user.email", "t@thinkrail.test");
	sh(repo, "config", "user.name", "test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-m", "init");
});

afterEach(() => {
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

function headSha(): string {
	const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]);
	return r.stdout.toString().trim();
}

test("clean tree: marker records head + branch, no patch", async () => {
	await captureSessionBaseline("s-clean", repo);
	const baseline = await readSessionBaseline("s-clean");
	expect(baseline?.sessionId).toBe("s-clean");
	expect(baseline?.cwd).toBe(repo);
	const git = baseline?.git;
	if (git?.state !== "captured") throw new Error(`expected captured, got ${git?.state}`);
	expect(git.head).toBe(headSha());
	expect(git.branch).toBe("main");
	expect(git.dirty).toBe(false);
	expect(git.patchFile).toBeUndefined();
});

test("dirty tree: patch covers tracked edits and untracked files, not ignored ones", async () => {
	writeFileSync(join(repo, "README.md"), "# repo\nedited\n");
	writeFileSync(join(repo, "untracked.txt"), "new file\n");
	writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(repo, "ignored.txt"), "never captured\n");
	await captureSessionBaseline("s-dirty", repo);
	const baseline = await readSessionBaseline("s-dirty");
	const git = baseline?.git;
	if (git?.state !== "captured") throw new Error(`expected captured, got ${git?.state}`);
	expect(git.dirty).toBe(true);
	expect(git.patchFile).toBe("s-dirty.patch");
	const patch = readFileSync(join(sessionBaselineDir(), "s-dirty.patch"), "utf8");
	expect(patch).toContain("untracked.txt");
	expect(patch).toContain("edited");
	expect(patch).not.toContain("ignored.txt\n+never captured");
	expect(git.patchBytes).toBe(Buffer.byteLength(patch, "utf8"));
	// the user's real index stays untouched: README edit is still unstaged
	const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]).stdout.toString();
	expect(status).toContain(" M README.md");
});

test("non-git cwd: marker records unavailable, never throws", async () => {
	const plain = join(dataDir, "plain");
	mkdirSync(plain);
	await captureSessionBaseline("s-plain", plain);
	const baseline = await readSessionBaseline("s-plain");
	expect(baseline?.git.state).toBe("unavailable");
});

test("capture prunes markers older than the retention window", async () => {
	await captureSessionBaseline("s-old", repo);
	const old = join(sessionBaselineDir(), "s-old.json");
	const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
	utimesSync(old, stale, stale);
	await captureSessionBaseline("s-new", repo);
	expect(await readSessionBaseline("s-old")).toBeNull();
	expect(await readSessionBaseline("s-new")).not.toBeNull();
});

async function expectOversizeSkip(sessionId: string): Promise<void> {
	const objectsBefore = Bun.spawnSync(["git", "-C", repo, "count-objects"]).stdout.toString();
	await captureSessionBaseline(sessionId, repo);
	const baseline = await readSessionBaseline(sessionId);
	const git = baseline?.git;
	if (git?.state !== "captured") throw new Error(`expected captured, got ${git?.state}`);
	expect(git.dirty).toBe(true);
	expect(git.patchOmitted).toBe("too-large");
	expect(git.patchFile).toBeUndefined();
	const objectsAfter = Bun.spawnSync(["git", "-C", repo, "count-objects"]).stdout.toString();
	expect(objectsAfter).toBe(objectsBefore);
}

test("an oversize untracked file skips patch work before any blob is written", async () => {
	writeFileSync(join(repo, "huge.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
	await expectOversizeSkip("s-huge");
});

test("an oversize file nested in an untracked directory is still caught", async () => {
	mkdirSync(join(repo, "newdir"));
	writeFileSync(join(repo, "newdir", "big.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
	await expectOversizeSkip("s-nested");
});

test("an oversize file with a non-ASCII name is still caught", async () => {
	writeFileSync(join(repo, "gr\u00f6\u00dfe.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
	await expectOversizeSkip("s-nonascii");
});

test("many small dirty files summing past the cap are skipped as too-large", async () => {
	for (let i = 0; i < 3; i++) {
		writeFileSync(join(repo, `part-${i}.bin`), Buffer.alloc(3 * 1024 * 1024, i + 1));
	}
	await expectOversizeSkip("s-sum");
});

test("replaying the patch reproduces the dirty state from a clean checkout", async () => {
	writeFileSync(join(repo, "README.md"), "# repo\nedited\n");
	writeFileSync(join(repo, "untracked.txt"), "new file\n");
	await captureSessionBaseline("s-replay", repo);
	const baseline = await readSessionBaseline("s-replay");
	const git = baseline?.git;
	if (git?.state !== "captured" || !git.patchFile) throw new Error("expected a patch");

	const clone = join(dataDir, "clone");
	sh(dataDir, "clone", repo, clone);
	sh(clone, "checkout", git.head);
	sh(clone, "apply", join(sessionBaselineDir(), git.patchFile));
	expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("# repo\nedited\n");
	expect(readFileSync(join(clone, "untracked.txt"), "utf8")).toBe("new file\n");
});
