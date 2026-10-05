import type { EventMetrics, ToolCallCount } from "./schemas";

export type CapturedEvent = { type: string } & Record<string, unknown>;

type AssistantUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

export function deriveEventMetrics(
	events: readonly CapturedEvent[],
	opts: { durationMs: number },
): EventMetrics {
	let model = "";
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let costUsd: number | null = null;
	let turns = 0;
	let compactionCount = 0;
	let firstCompactionAtTurn: number | null = null;
	let specToolCalls = 0;
	const subagentTasks: string[] = [];
	const toolCounts = new Map<string, ToolCallCount>();
	const callTool = new Map<string, string>();

	for (const event of events) {
		switch (event.type) {
			case "message_end": {
				const message = event.message as
					| { role?: string; model?: string; usage?: AssistantUsage }
					| undefined;
				if (message?.role !== "assistant") break;
				if (typeof message.model === "string" && message.model) model = message.model;
				const usage = message.usage;
				if (!usage) break;
				tokens.input += usage.input ?? 0;
				tokens.output += usage.output ?? 0;
				tokens.cacheRead += usage.cacheRead ?? 0;
				tokens.cacheWrite += usage.cacheWrite ?? 0;
				const total = usage.cost?.total;
				if (typeof total === "number") costUsd = (costUsd ?? 0) + total;
				break;
			}
			case "turn_end":
				turns += 1;
				break;
			case "tool_execution_start": {
				const toolName = String(event.toolName ?? "");
				if (!toolName) break;
				const callId = String(event.toolCallId ?? "");
				if (callId) callTool.set(callId, toolName);
				const count = toolCounts.get(toolName) ?? { tool: toolName, calls: 0, failures: 0 };
				count.calls += 1;
				toolCounts.set(toolName, count);
				if (toolName.startsWith("spec_")) specToolCalls += 1;
				if (toolName === "Agent") {
					const task = (event.args as { task?: unknown } | undefined)?.task;
					if (typeof task === "string" && task) subagentTasks.push(task);
				}
				break;
			}
			case "tool_execution_end": {
				if (event.isError !== true) break;
				const toolName = callTool.get(String(event.toolCallId ?? ""));
				const count = toolName ? toolCounts.get(toolName) : undefined;
				if (count) count.failures += 1;
				break;
			}
			case "compaction_start":
				if (firstCompactionAtTurn === null) firstCompactionAtTurn = turns + 1;
				break;
			case "compaction_end":
				if (event.aborted !== true) compactionCount += 1;
				break;
			default:
				break;
		}
	}

	return {
		model,
		tokens,
		costUsd,
		durationMs: opts.durationMs,
		turns,
		toolCalls: [...toolCounts.values()],
		compactionCount,
		firstCompactionAtTurn,
		subagentTasks,
		specToolCalls,
	};
}
