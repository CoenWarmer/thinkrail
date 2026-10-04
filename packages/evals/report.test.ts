import { expect, test } from "bun:test";
import { renderReport, summarizeByCondition } from "./report";
import type { TrialRecord } from "./schemas";

function record(overrides: Partial<TrialRecord> & { conditionId: string }): TrialRecord {
	return {
		version: 1,
		experimentId: "exp",
		trial: 1,
		sessionId: "s",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		status: "completed",
		event: {
			model: "m",
			tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			costUsd: 0.1,
			durationMs: 60_000,
			turns: 3,
			toolCalls: [{ tool: "read", calls: 4, failures: 0 }],
			compactionCount: 0,
			firstCompactionAtTurn: null,
			subagentTasks: [],
			specToolCalls: 0,
		},
		artifact: { filesTouched: ["a.ts"], commentsIntroduced: 0, validations: [] },
		verdict: { pass: true, failures: [] },
		...overrides,
	};
}

test("summarizes per condition in first-seen order with averages and rates", () => {
	const records = [
		record({ conditionId: "baseline" }),
		record({
			conditionId: "baseline",
			status: "crashed",
			event: null,
			artifact: null,
			verdict: { pass: false, failures: ["boom"] },
		}),
		record({
			conditionId: "cheap",
			event: {
				...(record({ conditionId: "x" }).event ?? ({} as never)),
				costUsd: 0.02,
				turns: 5,
			},
			artifact: {
				filesTouched: [],
				commentsIntroduced: 0,
				validations: [{ name: "t", command: "c", pass: false, exitCode: 1 }],
			},
			verdict: { pass: false, failures: ["validation failed: t"] },
		}),
	];
	const summaries = summarizeByCondition(records);
	expect(summaries.map((s) => s.conditionId)).toEqual(["baseline", "cheap"]);
	const baseline = summaries[0];
	expect(baseline?.trials).toBe(2);
	expect(baseline?.completed).toBe(1);
	expect(baseline?.crashed).toBe(1);
	expect(baseline?.passRate).toBe(0.5);
	expect(baseline?.avgCostUsd).toBeCloseTo(0.1);
	expect(baseline?.validationPassRate).toBeNull();
	const cheap = summaries[1];
	expect(cheap?.avgCostUsd).toBeCloseTo(0.02);
	expect(cheap?.validationPassRate).toBe(0);
});

test("renders a readable report with deltas against the first condition", () => {
	const text = renderReport(
		summarizeByCondition([
			record({ conditionId: "baseline" }),
			record({
				conditionId: "cheap",
				event: { ...(record({ conditionId: "x" }).event ?? ({} as never)), costUsd: 0.02 },
			}),
		]),
	);
	expect(text).toContain("condition baseline (1 trial)");
	expect(text).toContain("condition cheap (1 trial)");
	expect(text).toContain("vs baseline");
	expect(text).toContain("$0.0200");
});

test("an empty record set renders honestly", () => {
	expect(renderReport([])).toBe("no trial records");
});
