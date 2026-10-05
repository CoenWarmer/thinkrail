import { expect, test } from "bun:test";
import { type CapturedEvent, deriveEventMetrics } from "./events";

function assistant(model: string, usage: Record<string, unknown>): CapturedEvent {
	return { type: "message_end", message: { role: "assistant", model, usage } };
}

const usage = (input: number, output: number, total: number) => ({
	input,
	output,
	cacheRead: 5,
	cacheWrite: 2,
	cost: { total },
});

test("sums pi-reported usage and cost across assistant messages", () => {
	const metrics = deriveEventMetrics(
		[
			assistant("m-1", usage(100, 20, 0.01)),
			{ type: "turn_end" },
			assistant("m-2", usage(50, 10, 0.02)),
			{ type: "turn_end" },
		],
		{ durationMs: 1234 },
	);
	expect(metrics.model).toBe("m-2");
	expect(metrics.tokens).toEqual({ input: 150, output: 30, cacheRead: 10, cacheWrite: 4 });
	expect(metrics.costUsd).toBeCloseTo(0.03);
	expect(metrics.turns).toBe(2);
	expect(metrics.durationMs).toBe(1234);
});

test("cost stays null when no assistant message reported one", () => {
	const metrics = deriveEventMetrics([{ type: "turn_end" }], { durationMs: 0 });
	expect(metrics.costUsd).toBeNull();
	expect(metrics.model).toBe("");
});

test("counts tool calls, failures, spec tools, and subagent tasks", () => {
	const metrics = deriveEventMetrics(
		[
			{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
			{ type: "tool_execution_end", toolCallId: "1", isError: false },
			{ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} },
			{ type: "tool_execution_end", toolCallId: "2", isError: true },
			{ type: "tool_execution_start", toolCallId: "3", toolName: "spec_grep", args: {} },
			{
				type: "tool_execution_start",
				toolCallId: "4",
				toolName: "Agent",
				args: { task: "scout the repo" },
			},
		],
		{ durationMs: 0 },
	);
	expect(metrics.toolCalls).toContainEqual({ tool: "read", calls: 2, failures: 1 });
	expect(metrics.specToolCalls).toBe(1);
	expect(metrics.subagentTasks).toEqual(["scout the repo"]);
});

test("tracks compactions: first-at-turn and completed count, aborted excluded", () => {
	const metrics = deriveEventMetrics(
		[
			{ type: "turn_end" },
			{ type: "compaction_start", reason: "threshold" },
			{ type: "compaction_end", reason: "threshold", aborted: true },
			{ type: "turn_end" },
			{ type: "compaction_start", reason: "threshold" },
			{ type: "compaction_end", reason: "threshold", aborted: false },
		],
		{ durationMs: 0 },
	);
	expect(metrics.firstCompactionAtTurn).toBe(2);
	expect(metrics.compactionCount).toBe(1);
});
