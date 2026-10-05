import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EvalExperiment, EvalFixtureSummary, EvalTrialRecord } from "@thinkrail/contracts";
import { extractSessionSeed, type Fixture, promoteFixture, readFixture } from "@thinkrail/evals";
import { dataDir } from "../persistence";
import { readSessionBaseline } from "../session-baseline";

export function evalsRoot(): string {
	return join(dataDir(), "evals");
}

export function fixturesRoot(): string {
	return join(evalsRoot(), "fixtures");
}

export function recordsPath(): string {
	return join(evalsRoot(), "trials.jsonl");
}

export function trialWorkspacePath(
	experimentId: string,
	conditionId: string,
	trial: number,
): string {
	return join(evalsRoot(), "work", `${experimentId}-${conditionId}-${trial}`);
}

function experimentsDir(): string {
	return join(evalsRoot(), "experiments");
}

function fixtureProjectId(fixtureId: string): string | null {
	try {
		const raw = readFileSync(join(fixturesRoot(), fixtureId, "project.json"), "utf8");
		return (JSON.parse(raw) as { projectId?: string }).projectId ?? null;
	} catch {
		return null;
	}
}

export function toWireFixture(fixture: Fixture): EvalFixtureSummary {
	return {
		id: fixture.id,
		createdAt: fixture.createdAt,
		source: fixture.source,
		workspace: fixture.workspace,
		userTurns: fixture.user.turns.map((turn) => turn.text),
		config: fixture.config,
	};
}

export function listFixtures(projectId: string): EvalFixtureSummary[] {
	let ids: string[];
	try {
		ids = readdirSync(fixturesRoot());
	} catch {
		return [];
	}
	const fixtures: EvalFixtureSummary[] = [];
	for (const id of ids) {
		if (fixtureProjectId(id) !== projectId) continue;
		try {
			fixtures.push(toWireFixture(readFixture(fixturesRoot(), id)));
		} catch {
			// a torn or foreign directory is not a fixture
		}
	}
	return fixtures.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loadFixture(fixtureId: string): Fixture {
	return readFixture(fixturesRoot(), fixtureId);
}

export async function promoteSession(opts: {
	projectId: string;
	sessionId: string;
	cwd: string;
	fixtureId?: string;
}): Promise<EvalFixtureSummary> {
	const marker = await readSessionBaseline(opts.sessionId);
	if (!marker)
		throw new Error(
			`Session ${opts.sessionId} has no start-state marker — only sessions started after baseline capture shipped can become fixtures.`,
		);
	if (marker.git.state !== "captured")
		throw new Error(
			`Session ${opts.sessionId} has no usable git start state: ${marker.git.reason}`,
		);
	const sessionPath = SessionManager.findById(opts.cwd, opts.sessionId);
	if (!sessionPath) throw new Error(`Session ${opts.sessionId} was not found in this workspace.`);
	const seed = extractSessionSeed(readFileSync(sessionPath, "utf8"));
	if (seed.userTurns.length === 0)
		throw new Error(`Session ${opts.sessionId} has no user messages to replay.`);
	const markerDir = join(dataDir(), "session-baselines");
	const fixture = promoteFixture(fixturesRoot(), {
		id: opts.fixtureId ?? `fx-${opts.sessionId.slice(0, 8)}-${Date.now().toString(36)}`,
		source: { sessionId: opts.sessionId, cwd: marker.cwd },
		workspace: { head: marker.git.head, branch: marker.git.branch },
		...(marker.git.patchFile ? { patchPath: join(markerDir, marker.git.patchFile) } : {}),
		userTurns: seed.userTurns,
		config: {
			...(seed.model ? { model: seed.model } : {}),
			...(seed.thinkingLevel ? { thinkingLevel: seed.thinkingLevel } : {}),
			specsAvailable: true,
		},
		transcriptPath: sessionPath,
	});
	writeFileSync(
		join(fixturesRoot(), fixture.id, "project.json"),
		`${JSON.stringify({ projectId: opts.projectId })}\n`,
	);
	return toWireFixture(fixture);
}

export function readTrialTranscript(opts: {
	experimentId: string;
	conditionId: string;
	trial: number;
	sessionId: string;
}): { messages: unknown[] } {
	const cwd = trialWorkspacePath(opts.experimentId, opts.conditionId, opts.trial);
	const path = SessionManager.findById(cwd, opts.sessionId);
	if (!path) throw new Error(`Trial session ${opts.sessionId} was not found.`);
	const messages: unknown[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: unknown };
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		} catch {
			// a torn live tail line is expected mid-write
		}
	}
	return { messages };
}

type ExperimentEnvelope = { projectId: string; experiment: EvalExperiment };

export function saveExperiment(projectId: string, experiment: EvalExperiment): EvalExperiment {
	if (!experiment.id || !/^[\w][\w.-]*$/.test(experiment.id))
		throw new Error(`Experiment id "${experiment.id}" must be a simple name.`);
	if (experiment.conditions.length === 0) throw new Error("An experiment needs a condition.");
	if (!Number.isInteger(experiment.trialsPerCondition) || experiment.trialsPerCondition < 1)
		throw new Error("trialsPerCondition must be a positive integer.");
	loadFixture(experiment.fixtureId);
	mkdirSync(experimentsDir(), { recursive: true });
	const envelope: ExperimentEnvelope = { projectId, experiment };
	writeFileSync(
		join(experimentsDir(), `${experiment.id}.json`),
		`${JSON.stringify(envelope, null, "\t")}\n`,
	);
	return experiment;
}

export function deleteExperiment(projectId: string, experimentId: string): void {
	if (!/^[\w][\w.-]*$/.test(experimentId))
		throw new Error(`Experiment id "${experimentId}" must be a simple name.`);
	const file = join(experimentsDir(), `${experimentId}.json`);
	if (!existsSync(file)) throw new Error(`Unknown experiment: ${experimentId}`);
	const envelope = JSON.parse(readFileSync(file, "utf8")) as ExperimentEnvelope;
	if (envelope.projectId !== projectId)
		throw new Error(`Experiment ${experimentId} does not belong to this project.`);
	rmSync(file);
}

export function listExperiments(projectId: string): EvalExperiment[] {
	let names: string[];
	try {
		names = readdirSync(experimentsDir());
	} catch {
		return [];
	}
	const experiments: EvalExperiment[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const envelope = JSON.parse(
				readFileSync(join(experimentsDir(), name), "utf8"),
			) as ExperimentEnvelope;
			if (envelope.projectId === projectId) experiments.push(envelope.experiment);
		} catch {
			// unreadable envelopes stay invisible rather than breaking the list
		}
	}
	return experiments.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadExperiment(experimentId: string): EvalExperiment {
	const file = join(experimentsDir(), `${experimentId}.json`);
	if (!existsSync(file)) throw new Error(`Unknown experiment: ${experimentId}`);
	return (JSON.parse(readFileSync(file, "utf8")) as ExperimentEnvelope).experiment;
}

export function listTrials(experimentId: string): EvalTrialRecord[] {
	let raw: string;
	try {
		raw = readFileSync(recordsPath(), "utf8");
	} catch {
		return [];
	}
	const trials: EvalTrialRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as EvalTrialRecord & { version?: number };
			if (record.experimentId !== experimentId) continue;
			const { version: _version, ...wire } = record;
			trials.push(wire);
		} catch {
			// a torn tail line never breaks the read
		}
	}
	return trials;
}
