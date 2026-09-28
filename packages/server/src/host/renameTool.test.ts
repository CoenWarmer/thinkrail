import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { renameSession } from "../agent";
import { defaultSessionDirFor, writeFixtureSession } from "../history/testFixtures";
import { resetConfigCache } from "../settings";
import { createWorkspace, getWorkspace, listWorkspaces, renameWorkspace } from "../workspaces";
import { applyAgentRename } from "./renameTool";

let dataDir: string;
let repo: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!result.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-rename-tool-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "agent");
	resetConfigCache();
	repo = join(dataDir, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@thinkrail.test");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	writeFileSync(
		join(dataDir, "projects.json"),
		JSON.stringify([{ id: "p1", name: "repo", path: repo, slug: "repo", lastOpened: 1 }]),
	);
});

afterEach(() => {
	resetConfigCache();
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function chatIn(worktreePath: string) {
	return writeFixtureSession(
		defaultSessionDirFor(process.env.PI_CODING_AGENT_DIR ?? "", worktreePath),
		{ cwd: worktreePath, messages: [{ role: "user", text: "hello", timestamp: Date.now() }] },
	);
}

test("renames chat + workspace + branch without locking, so the agent can rename again", async () => {
	const ws = await createWorkspace("p1");
	const chat = chatIn(ws.worktreePath);

	const text = await applyAgentRename(chat.id, ws.id, {
		chatTitle: "Fix login redirect",
		workspaceName: "Login Redirect",
	});
	expect(text).toBe(
		'Chat: renamed to "Fix login redirect".\nWorkspace: renamed to "Login Redirect" (branch renamed to "login-redirect").',
	);
	expect(SessionManager.open(chat.path).getSessionName()).toBe("Fix login redirect");
	expect(getWorkspace(ws.id)).toMatchObject({ name: "Login Redirect", branch: "login-redirect" });
	expect(getWorkspace(ws.id).renamed).toBeUndefined();

	await applyAgentRename(chat.id, ws.id, {
		chatTitle: "Auth cleanup",
		workspaceName: "Auth Cleanup",
	});
	expect(SessionManager.open(chat.path).getSessionName()).toBe("Auth cleanup");
	expect(getWorkspace(ws.id).branch).toBe("auth-cleanup");
});

test("each target independently skips when the user named it manually", async () => {
	const ws = await createWorkspace("p1");
	const chat = chatIn(ws.worktreePath);
	await renameSession(chat.id, ws.id, ws.worktreePath, "My chat", "manual");

	expect(await applyAgentRename(chat.id, ws.id, { chatTitle: "Agent chat" })).toBe(
		"Chat: skipped — the user named it manually.",
	);
	expect(SessionManager.open(chat.path).getSessionName()).toBe("My chat");
	expect(await applyAgentRename(chat.id, ws.id, { workspaceName: "Agent Workspace" })).toContain(
		"Workspace: renamed",
	);

	renameWorkspace(ws.id, "Mine", { lock: true, renameBranch: false });
	expect(await applyAgentRename(chat.id, ws.id, { workspaceName: "Again" })).toBe(
		"Workspace: skipped — the user named it manually.",
	);
	expect(getWorkspace(ws.id).name).toBe("Mine");
});

test("a pushed branch is kept and the Default workspace is never renamed", async () => {
	const ws = await createWorkspace("p1");
	git(repo, "update-ref", `refs/remotes/origin/${ws.branch}`, "HEAD");
	const chat = chatIn(ws.worktreePath);
	expect(await applyAgentRename(chat.id, ws.id, { workspaceName: "Shipped Work" })).toBe(
		`Workspace: renamed to "Shipped Work" (branch "${ws.branch}" kept).`,
	);

	const defaultWs = (await listWorkspaces("p1")).find((w) => w.kind === "default");
	if (!defaultWs) throw new Error("expected the Default workspace");
	const defaultChat = chatIn(defaultWs.worktreePath);
	expect(
		await applyAgentRename(defaultChat.id, defaultWs.id, {
			chatTitle: "Repo chat",
			workspaceName: "X",
		}),
	).toBe(
		'Chat: renamed to "Repo chat".\nWorkspace: skipped — the Default workspace keeps its name.',
	);
});
