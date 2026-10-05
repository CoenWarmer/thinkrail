import { describe, expect, test } from "bun:test";
import type { EvalTrialRecord } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import { selectEvalConditionAggregates } from "./selectors";

const trial = (conditionId: string, n: number, pass = true): EvalTrialRecord => ({
	experimentId: "exp",
	conditionId,
	trial: n,
	sessionId: `s-${conditionId}-${n}`,
	startedAt: "2026-01-01T00:00:00.000Z",
	endedAt: "2026-01-01T00:01:00.000Z",
	status: "completed",
	event: {
		model: "m",
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0.1,
		durationMs: 1000,
		turns: 2,
		toolCalls: [],
		compactionCount: 0,
		firstCompactionAtTurn: null,
		subagentTasks: [],
		specToolCalls: 0,
	},
	artifact: null,
	verdict: pass ? { pass: true, failures: [] } : { pass: false, failures: ["x"] },
});

describe("eval slice", () => {
	test("hydrate + push fold is idempotent and dedupes appended trials", () => {
		const store = useAppStore.getState();
		store.setProjectEvals("p1", { fixtures: [], experiments: [] }, null);
		store.setEvalTrials("exp", [trial("baseline", 1)]);
		const run = {
			experimentId: "exp",
			activeTrial: null,
			spentUsd: 0.1,
			completedTrials: 1,
			totalTrials: 2,
			stopping: false,
		};
		store.applyEvalUpdate({ run, trialAppended: trial("baseline", 2) });
		store.applyEvalUpdate({ run, trialAppended: trial("baseline", 2) });
		expect(useAppStore.getState().evalTrialsByExperiment.exp).toHaveLength(2);
		expect(useAppStore.getState().evalRun?.spentUsd).toBe(0.1);
		store.applyEvalUpdate({ run: null });
		expect(useAppStore.getState().evalRun).toBeNull();
	});

	test("condition aggregates derive per condition in first-seen order", () => {
		useAppStore
			.getState()
			.setEvalTrials("exp2", [trial("a", 1), trial("a", 2, false), trial("b", 1)]);
		const aggregates = selectEvalConditionAggregates(useAppStore.getState(), "exp2");
		expect(aggregates.map((a) => a.conditionId)).toEqual(["a", "b"]);
		expect(aggregates[0]?.passRate).toBe(0.5);
		expect(aggregates[0]?.avgCostUsd).toBeCloseTo(0.1);
	});
});
