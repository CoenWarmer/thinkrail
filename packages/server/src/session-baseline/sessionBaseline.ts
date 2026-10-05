import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAsync, nonInteractiveGitEnv } from "../git";
import { logger } from "../log";
import { dataDir } from "../persistence";

const log = logger("session-baseline");

const GIT_TIMEOUT_MS = 60_000;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type SessionBaselineGit =
	| {
			state: "captured";
			head: string;
			branch: string;
			dirty: boolean;
			patchFile?: string;
			patchBytes?: number;
			patchOmitted?: "too-large" | "capture-failed";
	  }
	| { state: "unavailable"; reason: string };

export type SessionBaseline = {
	version: 1;
	sessionId: string;
	cwd: string;
	capturedAt: string;
	git: SessionBaselineGit;
};

export function sessionBaselineDir(): string {
	return join(dataDir(), "session-baselines");
}

export async function captureSessionBaseline(sessionId: string, cwd: string): Promise<void> {
	try {
		const baseline: SessionBaseline = {
			version: 1,
			sessionId,
			cwd,
			capturedAt: new Date().toISOString(),
			git: await captureGitState(sessionId, cwd),
		};
		await writeJsonAtomic(join(sessionBaselineDir(), `${sessionId}.json`), baseline);
	} catch (err) {
		log.warn(`baseline capture failed for session ${sessionId}: ${String(err)}`);
	}
	await pruneStaleBaselines().catch(() => {});
}

export async function readSessionBaseline(sessionId: string): Promise<SessionBaseline | null> {
	try {
		const raw = await readFile(join(sessionBaselineDir(), `${sessionId}.json`), "utf8");
		return JSON.parse(raw) as SessionBaseline;
	} catch {
		return null;
	}
}

async function captureGitState(sessionId: string, cwd: string): Promise<SessionBaselineGit> {
	const run = (args: string[], env?: Record<string, string | undefined>) =>
		gitAsync(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, raw: false, ...(env ? { env } : {}) });

	const head = await run(["rev-parse", "HEAD"]);
	if (!head.ok) {
		return { state: "unavailable", reason: head.err || "not a git repository or unborn HEAD" };
	}
	const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
	const status = await gitAsync(cwd, ["status", "--porcelain", "-z", "-uall"], {
		timeoutMs: GIT_TIMEOUT_MS,
		raw: true,
	});
	const captured: SessionBaselineGit = {
		state: "captured",
		head: head.out,
		branch: branch.ok ? branch.out : "",
		dirty: status.ok && status.out.length > 0,
	};
	if (!status.ok) return { ...captured, dirty: true, patchOmitted: "capture-failed" };
	if (!captured.dirty) return captured;

	const oversize = await oversizeDirtyTotal(cwd, status.out);
	if (oversize !== null) return { ...captured, patchBytes: oversize, patchOmitted: "too-large" };

	const patch = await renderDirtyPatch(cwd, run);
	if (patch === null) return { ...captured, patchOmitted: "capture-failed" };
	const patchBytes = Buffer.byteLength(patch, "utf8");
	if (patchBytes > MAX_PATCH_BYTES) return { ...captured, patchBytes, patchOmitted: "too-large" };

	const patchFile = `${sessionId}.patch`;
	await mkdir(sessionBaselineDir(), { recursive: true });
	await writeFile(join(sessionBaselineDir(), patchFile), patch);
	return { ...captured, patchFile, patchBytes };
}

// pre-check so the patch cap also prevents `add -A` writing oversize blobs into real .git/objects;
// -z -uall input: NUL-separated, unquoted, every untracked file listed individually
async function oversizeDirtyTotal(cwd: string, zPorcelain: string): Promise<number | null> {
	const tokens = zPorcelain.split("\0");
	let total = 0;
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i] ?? "";
		if (entry.length < 4) continue;
		const kind = entry[0];
		const path = entry.slice(3);
		if (kind === "R" || kind === "C") i++;
		try {
			const info = await stat(join(cwd, path));
			if (info.isFile()) total += info.size;
			if (total > MAX_PATCH_BYTES) return total;
		} catch {
			// deleted or unreadable entries cannot inflate the patch
		}
	}
	return null;
}

async function renderDirtyPatch(
	cwd: string,
	run: (args: string[], env?: Record<string, string | undefined>) => ReturnType<typeof gitAsync>,
): Promise<string | null> {
	const indexFile = join(tmpdir(), `thinkrail-baseline-${randomUUID()}.index`);
	const env = { ...nonInteractiveGitEnv(), GIT_INDEX_FILE: indexFile };
	try {
		const read = await run(["read-tree", "HEAD"], env);
		if (!read.ok) return null;
		const add = await run(["add", "-A"], env);
		if (!add.ok) return null;
		const tree = await run(["write-tree"], env);
		if (!tree.ok) return null;
		const diff = await gitAsync(cwd, ["diff", "--binary", "HEAD", tree.out], {
			timeoutMs: GIT_TIMEOUT_MS,
			raw: true,
			env,
		});
		return diff.ok ? diff.out : null;
	} finally {
		await rm(indexFile, { force: true }).catch(() => {});
	}
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
	await mkdir(sessionBaselineDir(), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`);
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

async function pruneStaleBaselines(): Promise<void> {
	const dir = sessionBaselineDir();
	const cutoff = Date.now() - RETENTION_MS;
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(dir, name);
		try {
			const info = await stat(file);
			if (info.mtimeMs < cutoff) await rm(file, { force: true });
		} catch {
			// a concurrently pruned or unreadable entry is not an error
		}
	}
}
