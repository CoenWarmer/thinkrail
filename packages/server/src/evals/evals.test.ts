import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EvalExperiment, EvalUpdatePush } from "@thinkrail/contracts";
import type { TrialSessionFactory } from "@thinkrail/evals";
import { captureSessionBaseline } from "../session-baseline";
import { currentRunState, setEvalsPublisher, startRun, stopRun } from "./evalsRun";
import {
	listExperiments,
	listFixtures,
	listTrials,
	promoteSession,
	readTrialTranscript,
	saveExperiment,
	trialWorkspacePath,
} from "./evalsStore";

let dataDir: string;
let repo: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const savedPiDir = process.env.PI_CODING_AGENT_DIR;

function sh(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!r.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-evals-mod-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi-agent");
	mkdirSync(join(dataDir, "pi-agent"), { recursive: true });
	repo = join(dataDir, "repo");
	mkdirSync(repo);
	sh(repo, "init", "-b", "main");
	sh(repo, "config", "user.email", "t@thinkrail.test");
	sh(repo, "config", "user.name", "test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-m", "init");
	setEvalsPublisher(() => {});
});

afterEach(() => {
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
	if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedPiDir;
});

async function promoted(fixtureId: string): Promise<string> {
	const manager = SessionManager.create(repo);
	const sessionId = manager.getSessionId();
	manager.appendMessage({ role: "user", content: "fix the bug", timestamp: Date.now() } as never);
	await captureSessionBaseline(sessionId, repo);
	await promoteSession({ projectId: "p1", sessionId, cwd: repo, fixtureId });
	return sessionId;
}

test("promoteSession builds a project-scoped fixture from marker + session file", async () => {
	await promoted("fx-1");
	const fixtures = listFixtures("p1");
	expect(fixtures).toHaveLength(1);
	expect(fixtures[0]?.id).toBe("fx-1");
	expect(fixtures[0]?.userTurns).toEqual(["fix the bug"]);
	expect(listFixtures("other-project")).toEqual([]);
});

test("promotion without a baseline marker fails with the explanatory message", async () => {
	const manager = SessionManager.create(repo);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	await expect(
		promoteSession({ projectId: "p1", sessionId: manager.getSessionId(), cwd: repo }),
	).rejects.toThrow(/no start-state marker/);
});

const experiment = (overrides?: Partial<EvalExperiment>): EvalExperiment => ({
	id: "exp-1",
	fixtureId: "fx-1",
	conditions: [{ id: "baseline" }],
	trialsPerCondition: 1,
	trialBudget: { maxTurns: 5 },
	...overrides,
});

test("experiments round-trip per project and validate their fixture", async () => {
	await promoted("fx-1");
	saveExperiment("p1", experiment());
	expect(listExperiments("p1").map((e) => e.id)).toEqual(["exp-1"]);
	expect(listExperiments("p2")).toEqual([]);
	expect(() => saveExperiment("p1", experiment({ fixtureId: "missing" }))).toThrow();
	expect(() => saveExperiment("p1", experiment({ trialsPerCondition: 0 }))).toThrow();
});

const okFactory: TrialSessionFactory = async ({ onEvent }) => ({
	sessionId: "fake-session",
	async prompt() {
		onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				model: "m",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		});
		onEvent({ type: "turn_end" });
	},
	async dispose() {},
});

test("startRun verifies the confirmed budget and publishes a terminal update", async () => {
	await promoted("fx-1");
	saveExperiment("p1", experiment());
	expect(() =>
		startRun({
			experimentId: "exp-1",
			confirmedBudget: { trialBudget: { maxTurns: 99 }, totalTrials: 1 },
			factory: okFactory,
		}),
	).toThrow(/Budget confirmation/);

	const pushes: EvalUpdatePush[] = [];
	setEvalsPublisher((push) => pushes.push(push));
	const state = startRun({
		experimentId: "exp-1",
		confirmedBudget: { trialBudget: { maxTurns: 5 }, totalTrials: 1 },
		factory: okFactory,
	});
	expect(state.totalTrials).toBe(1);
	expect(currentRunState()?.experimentId).toBe("exp-1");
	await waitForTerminal(pushes);
	expect(currentRunState()).toBeNull();
	const trials = listTrials("exp-1");
	expect(trials).toHaveLength(1);
	expect(trials[0]?.status).toBe("completed");
	expect(trials[0]?.event?.costUsd).toBeCloseTo(0.01);
	const withRecord = pushes.find((p) => p.trialAppended);
	expect(withRecord?.trialAppended?.conditionId).toBe("baseline");
});

test("readTrialTranscript reads a trial's session file from disk, live or done", async () => {
	const trialCwd = trialWorkspacePath("exp-t", "baseline", 1);
	mkdirSync(trialCwd, { recursive: true });
	const manager = SessionManager.create(trialCwd);
	manager.appendMessage({ role: "user", content: "do it", timestamp: Date.now() } as never);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	const result = readTrialTranscript({
		experimentId: "exp-t",
		conditionId: "baseline",
		trial: 1,
		sessionId: manager.getSessionId(),
	});
	expect(result.messages).toHaveLength(2);
	expect((result.messages[0] as { role: string }).role).toBe("user");
	expect(() =>
		readTrialTranscript({
			experimentId: "exp-t",
			conditionId: "baseline",
			trial: 1,
			sessionId: "nope",
		}),
	).toThrow(/not found/);
});

test("a failed synchronous setup never wedges the one-active-run latch", async () => {
	await promoted("fx-1");
	saveExperiment("p1", experiment());
	mkdirSync(join(dataDir, "evals"), { recursive: true });
	writeFileSync(join(dataDir, "evals", "work"), "a file where the work dir must be");
	const confirmedBudget = { trialBudget: { maxTurns: 5 }, totalTrials: 1 };
	expect(() => startRun({ experimentId: "exp-1", confirmedBudget, factory: okFactory })).toThrow();
	expect(currentRunState()).toBeNull();
	rmSync(join(dataDir, "evals", "work"));
	const pushes: EvalUpdatePush[] = [];
	setEvalsPublisher((push) => pushes.push(push));
	startRun({ experimentId: "exp-1", confirmedBudget, factory: okFactory });
	await waitForTerminal(pushes);
	expect(listTrials("exp-1")).toHaveLength(1);
});

test("only one run may be active; stopRun skips remaining trials", async () => {
	await promoted("fx-1");
	saveExperiment("p1", experiment({ id: "exp-stop", trialsPerCondition: 5 }));
	const pushes: EvalUpdatePush[] = [];
	setEvalsPublisher((push) => pushes.push(push));
	let prompts = 0;
	const slowFactory: TrialSessionFactory = async ({ onEvent }) => ({
		sessionId: "slow",
		async prompt() {
			prompts += 1;
			stopRun("exp-stop");
			onEvent({ type: "turn_end" });
		},
		async dispose() {},
	});
	startRun({
		experimentId: "exp-stop",
		confirmedBudget: { trialBudget: { maxTurns: 5 }, totalTrials: 5 },
		factory: slowFactory,
	});
	expect(() =>
		startRun({
			experimentId: "exp-stop",
			confirmedBudget: { trialBudget: { maxTurns: 5 }, totalTrials: 5 },
			factory: okFactory,
		}),
	).toThrow(/already active/);
	await waitForTerminal(pushes);
	expect(prompts).toBe(1);
	expect(listTrials("exp-stop")).toHaveLength(1);
	expect(currentRunState()).toBeNull();
});

async function waitForTerminal(pushes: EvalUpdatePush[]): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (pushes.some((p) => p.run === null)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("run never published a terminal update");
}
