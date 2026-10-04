import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	EvalConfirmedBudget,
	EvalRunState,
	EvalTrialRecord,
	EvalUpdatePush,
} from "@thinkrail/contracts";
import {
	type CapturedEvent,
	type Experiment,
	runExperiment,
	type TrialSession,
	type TrialSessionFactory,
} from "@thinkrail/evals";
import { logger } from "../log";
import { evalsRoot, fixturesRoot, loadExperiment, loadFixture, recordsPath } from "./evalsStore";

const log = logger("evals");
const UPDATE_THROTTLE_MS = 1000;

type ActiveRun = {
	state: EvalRunState;
	stopRequested: boolean;
	liveSession: TrialSession | null;
	done: Promise<void>;
};

let active: ActiveRun | null = null;
let publish: (push: EvalUpdatePush) => void = () => {};
let lastPublishAt = 0;

export function setEvalsPublisher(fn: (push: EvalUpdatePush) => void): void {
	publish = fn;
}

export function currentRunState(): EvalRunState | null {
	return active ? { ...active.state, activeTrial: active.state.activeTrial } : null;
}

function publishUpdate(push: EvalUpdatePush, force: boolean): void {
	const now = Date.now();
	if (!force && now - lastPublishAt < UPDATE_THROTTLE_MS) return;
	lastPublishAt = now;
	publish(push);
}

export function startRun(opts: {
	experimentId: string;
	confirmedBudget: EvalConfirmedBudget;
	factory: TrialSessionFactory;
}): EvalRunState {
	if (active) throw new Error(`A run is already active (${active.state.experimentId}).`);
	const wireExperiment = loadExperiment(opts.experimentId);
	const fixture = loadFixture(wireExperiment.fixtureId);
	const totalTrials = wireExperiment.conditions.length * wireExperiment.trialsPerCondition;
	const confirmed = opts.confirmedBudget;
	if (
		JSON.stringify(confirmed.trialBudget) !== JSON.stringify(wireExperiment.trialBudget) ||
		confirmed.experimentMaxCostUsd !== wireExperiment.experimentMaxCostUsd ||
		confirmed.totalTrials !== totalTrials
	)
		throw new Error(
			"Budget confirmation does not match the stored experiment — re-open the run dialog.",
		);

	const experiment: Experiment = { version: 1, ...wireExperiment };
	const run: ActiveRun = {
		state: {
			experimentId: experiment.id,
			activeTrial: null,
			spentUsd: 0,
			completedTrials: 0,
			totalTrials,
			stopping: false,
		},
		stopRequested: false,
		liveSession: null,
		done: Promise.resolve(),
	};
	active = run;

	const factory: TrialSessionFactory = async ({ cwd, condition, onEvent }) => {
		const trial = (run.state.completedTrials % experiment.trialsPerCondition) + 1;
		run.state.activeTrial = {
			conditionId: condition.id,
			trial,
			sessionId: "",
			startedAt: new Date().toISOString(),
			costUsd: null,
		};
		const session = await opts.factory({
			cwd,
			condition,
			onEvent: (event: CapturedEvent) => {
				noteCost(run, event);
				onEvent(event);
				publishUpdate({ run: { ...run.state } }, false);
			},
		});
		run.liveSession = session;
		if (run.state.activeTrial) run.state.activeTrial.sessionId = session.sessionId;
		publishUpdate({ run: { ...run.state } }, true);
		return session;
	};

	const workDir = join(evalsRoot(), "work");
	mkdirSync(workDir, { recursive: true });
	run.done = runExperiment(
		{
			fixturesRoot: fixturesRoot(),
			workDir,
			recordPath: recordsPath(),
			createSession: factory,
			log: (line) => log.info(`run ${experiment.id}: ${line}`),
			shouldStop: () => run.stopRequested,
			onTrialRecord: (record) => {
				run.state.completedTrials += 1;
				run.state.spentUsd += record.event?.costUsd ?? 0;
				run.state.activeTrial = null;
				run.liveSession = null;
				const { version: _version, ...wire } = record;
				publishUpdate({ run: { ...run.state }, trialAppended: wire as EvalTrialRecord }, true);
			},
		},
		experiment,
		fixture,
	)
		.then(() => {})
		.catch((err) => {
			log.warn(`run ${experiment.id} failed: ${String(err)}`);
		})
		.finally(() => {
			active = null;
			publishUpdate({ run: null }, true);
		});

	publishUpdate({ run: { ...run.state } }, true);
	return { ...run.state };
}

export function stopRun(experimentId: string): boolean {
	if (!active || active.state.experimentId !== experimentId) return false;
	active.stopRequested = true;
	active.state.stopping = true;
	active.liveSession?.abort?.();
	publishUpdate({ run: { ...active.state } }, true);
	return true;
}

function noteCost(run: ActiveRun, event: CapturedEvent): void {
	if (event.type !== "message_end") return;
	const message = event.message as
		| { role?: string; usage?: { cost?: { total?: number } } }
		| undefined;
	const total = message?.role === "assistant" ? message.usage?.cost?.total : undefined;
	if (typeof total !== "number" || !run.state.activeTrial) return;
	run.state.activeTrial.costUsd = (run.state.activeTrial.costUsd ?? 0) + total;
}
