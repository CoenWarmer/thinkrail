import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedEvent } from "./events";
import { promoteFixture } from "./fixtures";
import { type RunnerDeps, runExperiment, type TrialSessionFactory } from "./runner";
import type { Experiment, Fixture, TrialRecord } from "./schemas";

let root: string;
let fixture: Fixture;

function sh(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
	if (!r.success) throw new Error(`git ${args.join(" ")} failed`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "trpi-runner-"));
	const repo = join(root, "source");
	mkdirSync(repo);
	sh(repo, "init", "-b", "main");
	sh(repo, "config", "user.email", "t@thinkrail.test");
	sh(repo, "config", "user.name", "test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-m", "init");
	const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
	fixture = promoteFixture(join(root, "fixtures"), {
		id: "fx",
		source: { sessionId: "s1", cwd: repo },
		workspace: { head, branch: "main" },
		userTurns: [{ text: "do the task" }, { text: "now follow up" }],
		config: { model: "prov/base-model", specsAvailable: true },
	});
});

const experiment: Experiment = {
	version: 1,
	id: "exp",
	fixtureId: "fx",
	conditions: [{ id: "baseline" }, { id: "variant", model: "prov/cheap-model" }],
	trialsPerCondition: 2,
	trialBudget: { maxTurns: 10 },
};

function assistantUsage(cost: number): CapturedEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			model: "m",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		},
	};
}

function scriptedFactory(
	perPrompt: (opts: { cwd: string; emit: (e: CapturedEvent) => void; turn: number }) => void,
): TrialSessionFactory {
	return async ({ cwd, onEvent }) => {
		let turn = 0;
		return {
			sessionId: `fake-${Math.random().toString(36).slice(2, 8)}`,
			async prompt() {
				turn += 1;
				perPrompt({ cwd, emit: onEvent, turn });
			},
			async dispose() {},
		};
	};
}

function deps(createSession: TrialSessionFactory, extra?: Partial<RunnerDeps>): RunnerDeps {
	return {
		fixturesRoot: join(root, "fixtures"),
		workDir: join(root, "work"),
		recordPath: join(root, "records", "trials.jsonl"),
		createSession,
		...extra,
	};
}

function readRecords(path: string): TrialRecord[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as TrialRecord);
}

test("runs conditions × trials in isolated workspaces and appends one record each", async () => {
	const cwds = new Set<string>();
	const factory = scriptedFactory(({ cwd, emit, turn }) => {
		cwds.add(cwd);
		emit(assistantUsage(0.01));
		emit({ type: "turn_end" });
		if (turn === 2) writeFileSync(join(cwd, "new.ts"), "export const done = true;\n");
	});
	const d = deps(factory);
	const records = await runExperiment(d, experiment, fixture);
	expect(records).toHaveLength(4);
	expect(cwds.size).toBe(4);
	expect(records.every((r) => r.status === "completed" && r.verdict.pass)).toBe(true);
	expect(records[0]?.event?.turns).toBe(2);
	expect(records[0]?.artifact?.filesTouched).toEqual(["new.ts"]);
	expect(readRecords(d.recordPath)).toEqual(records);
	const conditions = records.map((r) => r.conditionId);
	expect(conditions).toEqual(["baseline", "baseline", "variant", "variant"]);
});

test("a tripped trial budget records budget-exceeded and stops further turns", async () => {
	let prompts = 0;
	const factory = scriptedFactory(({ emit }) => {
		prompts += 1;
		emit({ type: "turn_end" });
	});
	const d = deps(factory);
	const records = await runExperiment(
		d,
		{
			...experiment,
			conditions: [{ id: "baseline" }],
			trialsPerCondition: 1,
			trialBudget: { maxTurns: 1 },
		},
		fixture,
	);
	expect(prompts).toBe(1);
	expect(records[0]?.status).toBe("budget-exceeded");
	expect(records[0]?.verdict.pass).toBe(false);
	expect(records[0]?.verdict.failures[0]).toMatch(/turn cap/);
});

test("a session hung in prompt() trips the wall budget and still records the trial", async () => {
	let aborted = false;
	const factory: TrialSessionFactory = async () => ({
		sessionId: "hung",
		prompt: () => new Promise<void>(() => {}),
		abort: () => {
			aborted = true;
		},
		async dispose() {},
	});
	const d = deps(factory);
	const records = await runExperiment(
		d,
		{
			...experiment,
			conditions: [{ id: "baseline" }],
			trialsPerCondition: 1,
			trialBudget: { maxWallMs: 2_000 },
		},
		fixture,
	);
	expect(aborted).toBe(true);
	expect(records[0]?.status).toBe("budget-exceeded");
	expect(records[0]?.verdict.failures[0]).toMatch(/wall time/);
	expect(readRecords(d.recordPath)).toHaveLength(1);
});

test("a mismatched fixture is refused before any trial runs", async () => {
	const factory = scriptedFactory(({ emit }) => emit({ type: "turn_end" }));
	await expect(
		runExperiment(deps(factory), { ...experiment, fixtureId: "other" }, fixture),
	).rejects.toThrow(/names fixture other/);
});

test("the experiment cost cap stops launching later trials", async () => {
	const factory = scriptedFactory(({ emit }) => {
		emit(assistantUsage(0.6));
		emit({ type: "turn_end" });
	});
	const d = deps(factory);
	const records = await runExperiment(
		d,
		{ ...experiment, trialsPerCondition: 5, experimentMaxCostUsd: 1 },
		fixture,
	);
	expect(records.length).toBe(1);
});

test("shouldStop halts before the next trial and onTrialRecord streams records", async () => {
	const seen: string[] = [];
	let stop = false;
	const factory = scriptedFactory(({ emit }) => {
		emit({ type: "turn_end" });
		stop = true;
	});
	const d = deps(factory, {
		shouldStop: () => stop,
		onTrialRecord: (record) => seen.push(`${record.conditionId}#${record.trial}`),
	});
	const records = await runExperiment(
		d,
		{ ...experiment, conditions: [{ id: "baseline" }], trialsPerCondition: 3 },
		fixture,
	);
	expect(records).toHaveLength(1);
	expect(seen).toEqual(["baseline#1"]);
});

test("a crashing session records a crashed trial with a failed verdict, never silence", async () => {
	const factory: TrialSessionFactory = async () => ({
		sessionId: "boom",
		async prompt() {
			throw new Error("provider exploded");
		},
		async dispose() {},
	});
	const d = deps(factory);
	const records = await runExperiment(
		d,
		{ ...experiment, conditions: [{ id: "baseline" }], trialsPerCondition: 1 },
		fixture,
	);
	expect(records[0]?.status).toBe("crashed");
	expect(records[0]?.error).toBe("provider exploded");
	expect(records[0]?.verdict).toEqual({ pass: false, failures: ["provider exploded"] });
	expect(existsSync(d.recordPath)).toBe(true);
});

test("failed validations fail the deterministic verdict", async () => {
	const factory = scriptedFactory(({ emit }) => emit({ type: "turn_end" }));
	const d = deps(factory, { validations: [{ name: "truth", command: "exit 1" }] });
	const records = await runExperiment(
		d,
		{ ...experiment, conditions: [{ id: "baseline" }], trialsPerCondition: 1 },
		fixture,
	);
	expect(records[0]?.status).toBe("completed");
	expect(records[0]?.verdict.pass).toBe(false);
	expect(records[0]?.verdict.failures).toEqual(["validation failed: truth"]);
});
