#!/usr/bin/env bun
// Dev CLI for the eval framework (phase 1, spends real provider tokens):
//   bun run eval promote --session <sessionId> --session-file <session.jsonl> --id <fixtureId> [--specs false] [--persona <brief>]
//   bun run eval run --experiment <experiment.json> [--records <path>]
//   bun run eval report [--records <path>] [--experiment <experimentId>]

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@thinkrail/contracts";
import {
	type CapturedEvent,
	type Experiment,
	extractSessionSeed,
	promoteFixture,
	type ResolvedCondition,
	readFixture,
	renderReport,
	resolveCondition,
	runExperiment,
	summarizeByCondition,
	type TrialRecord,
	type TrialSessionFactory,
} from "@thinkrail/evals";

const dataDir = process.env.THINKRAIL_DATA_DIR ?? join(homedir(), ".thinkrail");
const evalsRoot = join(dataDir, "evals");
const fixturesRoot = join(evalsRoot, "fixtures");
const defaultRecords = join(evalsRoot, "trials.jsonl");

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function requireArg(name: string): string {
	const value = arg(name);
	if (!value) fail(`missing required --${name}`);
	return value;
}

function fail(message: string): never {
	console.error(`eval: ${message}`);
	process.exit(1);
}

type BaselineMarker = {
	sessionId: string;
	cwd: string;
	git:
		| { state: "captured"; head: string; branch: string; dirty: boolean; patchFile?: string }
		| { state: "unavailable"; reason: string };
};

function promote(): void {
	const sessionId = requireArg("session");
	const sessionFile = requireArg("session-file");
	const id = requireArg("id");
	const markerPath = join(dataDir, "session-baselines", `${sessionId}.json`);
	if (!existsSync(markerPath))
		fail(
			`no baseline marker for session ${sessionId} (${markerPath}) — only sessions started after baseline capture shipped are promotable`,
		);
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as BaselineMarker;
	if (marker.git.state !== "captured")
		fail(`session ${sessionId} has no usable git baseline: ${marker.git.reason}`);
	const seed = extractSessionSeed(readFileSync(sessionFile, "utf8"));
	const persona = arg("persona");
	const fixture = promoteFixture(fixturesRoot, {
		id,
		source: { sessionId, cwd: marker.cwd },
		workspace: { head: marker.git.head, branch: marker.git.branch },
		...(marker.git.patchFile
			? { patchPath: join(dataDir, "session-baselines", marker.git.patchFile) }
			: {}),
		userTurns: seed.userTurns,
		...(persona ? { persona } : {}),
		config: {
			...(seed.model ? { model: seed.model } : {}),
			...(seed.thinkingLevel ? { thinkingLevel: seed.thinkingLevel } : {}),
			specsAvailable: arg("specs") !== "false",
		},
		transcriptPath: sessionFile,
	});
	console.log(
		`promoted session ${sessionId} → fixture ${fixture.id} (${fixturesRoot}/${fixture.id})`,
	);
	console.log(
		`  ${fixture.user.turns.length} user turn(s), head ${fixture.workspace.head.slice(0, 10)}, patch: ${fixture.workspace.patchFile ?? "none"}`,
	);
}

// Record<ThinkingLevel, true> forces exhaustiveness: a level added to pi's union fails here.
const THINKING_LEVEL_FLAGS: Record<ThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};
const THINKING_LEVELS = new Set<string>(Object.keys(THINKING_LEVEL_FLAGS));

async function run(): Promise<void> {
	const experimentPath = requireArg("experiment");
	const recordPath = arg("records") ?? defaultRecords;
	const experiment = JSON.parse(readFileSync(experimentPath, "utf8")) as Experiment;
	const fixture = readFixture(fixturesRoot, experiment.fixtureId);

	for (const condition of experiment.conditions) {
		assertSupportedKnobs(resolveCondition(fixture.config, condition));
	}

	const agentDir = join(evalsRoot, "agent-dir");
	mkdirSync(agentDir, { recursive: true });
	const defaultPiDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	for (const file of ["auth.json", "models.json", "settings.json"]) {
		const src = join(defaultPiDir, file);
		if (existsSync(src)) copyFileSync(src, join(agentDir, file));
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const agent = await import("@thinkrail/server/agent");

	const handlers = new Map<string, (event: CapturedEvent) => void>();
	agent.setSessionPublisher((payload) => {
		handlers.get(payload.sessionId)?.(payload.event as unknown as CapturedEvent);
	});

	let counter = 0;
	const createSession: TrialSessionFactory = async ({ cwd, condition, onEvent }) => {
		const created = await agent.createSession({
			cwd,
			workspaceId: `eval-${experiment.id}-${++counter}`,
			...(condition.model ? { model: parseModel(condition.model) } : {}),
			...(condition.thinkingLevel
				? { thinkingLevel: condition.thinkingLevel as ThinkingLevel }
				: {}),
		});
		handlers.set(created.sessionId, onEvent);
		return {
			sessionId: created.sessionId,
			prompt: (text: string) => agent.promptSession(created.sessionId, text),
			abort: () => void agent.abortSession(created.sessionId).catch(() => {}),
			dispose: async () => {
				handlers.delete(created.sessionId);
				await agent.removeSession(created.sessionId);
			},
		};
	};

	function assertSupportedKnobs(condition: ResolvedCondition): void {
		if (condition.model) parseModel(condition.model);
		if (condition.thinkingLevel && !THINKING_LEVELS.has(condition.thinkingLevel))
			fail(
				`condition ${condition.id}: thinking level "${condition.thinkingLevel}" is not a pi thinking level (${[...THINKING_LEVELS].join(", ")})`,
			);
		if (condition.specsAvailable !== fixture.config.specsAvailable)
			fail(
				`condition ${condition.id}: toggling specsAvailable is not supported by the phase-1 CLI binding`,
			);
		if (JSON.stringify(condition.skills) !== JSON.stringify(fixture.config.skills))
			fail(
				`condition ${condition.id}: changing skills is not supported by the phase-1 CLI binding`,
			);
		if (condition.promptVariant !== fixture.config.promptVariant)
			fail(
				`condition ${condition.id}: prompt variants are not supported by the phase-1 CLI binding`,
			);
		if (JSON.stringify(condition.tools) !== JSON.stringify(fixture.config.tools))
			fail(`condition ${condition.id}: tool sets are not supported by the phase-1 CLI binding`);
		if (JSON.stringify(condition.extensions) !== JSON.stringify(fixture.config.extensions))
			fail(
				`condition ${condition.id}: extension sets are not supported by the phase-1 CLI binding`,
			);
	}

	console.log(
		`running experiment ${experiment.id}: ${experiment.conditions.length} condition(s) × ${experiment.trialsPerCondition} trial(s) — real tokens will be spent`,
	);
	try {
		const records = await runExperiment(
			{
				fixturesRoot,
				workDir: join(evalsRoot, "work"),
				recordPath,
				createSession,
				log: (line) => console.log(`  ${line}`),
			},
			experiment,
			fixture,
		);
		console.log(`\n${renderReport(summarizeByCondition(records))}`);
		console.log(`\nrecords appended to ${recordPath}`);
	} finally {
		agent.disposeAllSessions();
	}
}

function parseModel(model: string): { provider: string; id: string } {
	const slash = model.indexOf("/");
	if (slash <= 0) fail(`condition model "${model}" is not provider/id`);
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function report(): void {
	const recordPath = arg("records") ?? defaultRecords;
	const experimentId = arg("experiment");
	if (!existsSync(recordPath)) fail(`no records at ${recordPath}`);
	const records = readFileSync(recordPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord)
		.filter((record) => !experimentId || record.experimentId === experimentId);
	const experimentIds = [...new Set(records.map((record) => record.experimentId))];
	for (const id of experimentIds) {
		if (experimentIds.length > 1) console.log(`\nexperiment ${id}`);
		console.log(renderReport(summarizeByCondition(records.filter((r) => r.experimentId === id))));
	}
	if (experimentIds.length === 0) console.log("no trial records");
}

const command = process.argv[2];
if (command === "promote") promote();
else if (command === "run") await run();
else if (command === "report") report();
else fail(`unknown command "${command ?? ""}" — use promote | run | report`);
