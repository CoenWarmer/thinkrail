import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveArtifactMetrics, type ValidationSpec } from "./artifacts";
import { type ResolvedCondition, resolveCondition } from "./conditions";
import { type CapturedEvent, deriveEventMetrics } from "./events";
import { replayFixtureWorkspace } from "./fixtures";
import type { BudgetLimits, Experiment, Fixture, TrialRecord, TrialStatus } from "./schemas";

export type TrialSession = {
	sessionId: string;
	prompt(text: string): Promise<void>;
	abort?(): void;
	dispose(): Promise<void>;
};

export type TrialSessionFactory = (opts: {
	cwd: string;
	condition: ResolvedCondition;
	onEvent: (event: CapturedEvent) => void;
}) => Promise<TrialSession>;

export type RunnerDeps = {
	fixturesRoot: string;
	workDir: string;
	recordPath: string;
	createSession: TrialSessionFactory;
	validations?: ValidationSpec[];
	log?: (line: string) => void;
};

export async function runExperiment(
	deps: RunnerDeps,
	experiment: Experiment,
	fixture: Fixture,
): Promise<TrialRecord[]> {
	if (fixture.id !== experiment.fixtureId)
		throw new Error(
			`experiment ${experiment.id} names fixture ${experiment.fixtureId} but got ${fixture.id}`,
		);
	const log = deps.log ?? (() => {});
	const records: TrialRecord[] = [];
	let spentUsd = 0;
	for (const condition of experiment.conditions) {
		const resolved = resolveCondition(fixture.config, condition);
		for (let trial = 1; trial <= experiment.trialsPerCondition; trial++) {
			if (
				experiment.experimentMaxCostUsd !== undefined &&
				spentUsd >= experiment.experimentMaxCostUsd
			) {
				log(
					`experiment ${experiment.id}: cost cap $${experiment.experimentMaxCostUsd} reached after $${spentUsd.toFixed(4)} — remaining trials skipped`,
				);
				return records;
			}
			log(`trial ${condition.id}#${trial} starting`);
			const record = await runTrial(deps, experiment, fixture, resolved, trial);
			appendRecord(deps.recordPath, record);
			records.push(record);
			spentUsd += record.event?.costUsd ?? 0;
			log(
				`trial ${condition.id}#${trial} ${record.status} (verdict ${record.verdict.pass ? "pass" : "fail"})`,
			);
		}
	}
	return records;
}

async function runTrial(
	deps: RunnerDeps,
	experiment: Experiment,
	fixture: Fixture,
	condition: ResolvedCondition,
	trial: number,
): Promise<TrialRecord> {
	const startedAt = Date.now();
	const events: CapturedEvent[] = [];
	const budget = createBudgetTracker(experiment.trialBudget, startedAt);
	let status: TrialStatus = "completed";
	let error: string | undefined;
	let cwd: string | undefined;
	let baseRef: string | undefined;
	let session: TrialSession | undefined;

	try {
		cwd = join(deps.workDir, `${experiment.id}-${condition.id}-${trial}`);
		baseRef = replayFixtureWorkspace(deps.fixturesRoot, fixture, cwd).baseRef;
		session = await deps.createSession({
			cwd,
			condition,
			onEvent: (event) => {
				events.push(event);
				budget.note(event);
				if (budget.trippedReason() && session?.abort) session.abort();
			},
		});
		const wallMs = experiment.trialBudget.maxWallMs;
		for (const turn of fixture.user.turns) {
			if (budget.trippedReason()) break;
			const remaining = wallMs === undefined ? undefined : wallMs - (Date.now() - startedAt);
			if (remaining !== undefined && remaining <= 0) {
				budget.tripWall(wallMs ?? 0);
				break;
			}
			const timedOut = await promptWithWallDeadline(session, turn.text, remaining);
			if (timedOut) {
				budget.tripWall(wallMs ?? 0);
				break;
			}
		}
		if (budget.trippedReason()) {
			status = "budget-exceeded";
			error = budget.trippedReason() ?? undefined;
		}
	} catch (cause) {
		status = "crashed";
		error = cause instanceof Error ? cause.message : String(cause);
	} finally {
		await boundedDispose(session);
	}

	const endedAt = Date.now();
	const event =
		events.length > 0 ? deriveEventMetrics(events, { durationMs: endedAt - startedAt }) : null;
	let artifact: TrialRecord["artifact"] = null;
	if (cwd && baseRef && status !== "crashed") {
		try {
			artifact = deriveArtifactMetrics(cwd, baseRef, deps.validations ?? []);
		} catch (cause) {
			status = "crashed";
			error = cause instanceof Error ? cause.message : String(cause);
		}
	}

	const failures: string[] = [];
	if (status !== "completed") failures.push(error ?? status);
	for (const validation of artifact?.validations ?? []) {
		if (!validation.pass) failures.push(`validation failed: ${validation.name}`);
	}

	return {
		version: 1,
		experimentId: experiment.id,
		conditionId: condition.id,
		trial,
		sessionId: session?.sessionId ?? "",
		startedAt: new Date(startedAt).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		status,
		...(error ? { error } : {}),
		event,
		artifact,
		verdict: { pass: failures.length === 0, failures },
	};
}

const DISPOSE_TIMEOUT_MS = 30_000;

async function boundedDispose(session: TrialSession | undefined): Promise<void> {
	if (!session) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolveTimeout) => {
		timer = setTimeout(resolveTimeout, DISPOSE_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		await Promise.race([session.dispose().catch(() => {}), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

function createBudgetTracker(limits: BudgetLimits, startedAt: number) {
	let turns = 0;
	let toolCalls = 0;
	let costUsd = 0;
	let reason: string | null = null;
	const trip = (message: string) => {
		if (!reason) reason = message;
	};
	return {
		note(event: CapturedEvent): void {
			if (event.type === "turn_end") turns += 1;
			else if (event.type === "tool_execution_start") toolCalls += 1;
			else if (event.type === "message_end") {
				const message = event.message as
					| { role?: string; usage?: { cost?: { total?: number } } }
					| undefined;
				const total = message?.role === "assistant" ? message.usage?.cost?.total : undefined;
				if (typeof total === "number") costUsd += total;
			}
			if (limits.maxTurns !== undefined && turns >= limits.maxTurns)
				trip(`budget: ${turns} turns reached the ${limits.maxTurns}-turn cap`);
			if (limits.maxToolCalls !== undefined && toolCalls >= limits.maxToolCalls)
				trip(`budget: ${toolCalls} tool calls reached the ${limits.maxToolCalls}-call cap`);
			if (limits.maxCostUsd !== undefined && costUsd >= limits.maxCostUsd)
				trip(`budget: $${costUsd.toFixed(4)} reached the $${limits.maxCostUsd} cost cap`);
			if (limits.maxWallMs !== undefined && Date.now() - startedAt >= limits.maxWallMs)
				trip(`budget: wall time reached the ${limits.maxWallMs}ms cap`);
		},
		trippedReason(): string | null {
			return reason;
		},
		tripWall(capMs: number): void {
			trip(`budget: wall time reached the ${capMs}ms cap`);
		},
	};
}

async function promptWithWallDeadline(
	session: TrialSession,
	text: string,
	remainingMs: number | undefined,
): Promise<boolean> {
	const prompt = session.prompt(text);
	if (remainingMs === undefined) {
		await prompt;
		return false;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout("timeout"), remainingMs);
		timer.unref?.();
	});
	try {
		const outcome = await Promise.race([prompt.then(() => "done" as const), deadline]);
		if (outcome === "done") return false;
		session.abort?.();
		void prompt.catch(() => {});
		return true;
	} finally {
		clearTimeout(timer);
	}
}

function appendRecord(recordPath: string, record: TrialRecord): void {
	mkdirSync(dirname(recordPath), { recursive: true });
	appendFileSync(recordPath, `${JSON.stringify(record)}\n`);
}
