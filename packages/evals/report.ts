import type { TrialRecord } from "./schemas";

export type ConditionSummary = {
	conditionId: string;
	trials: number;
	completed: number;
	budgetExceeded: number;
	crashed: number;
	passRate: number;
	avgCostUsd: number | null;
	avgDurationMs: number | null;
	avgTurns: number | null;
	avgToolCalls: number | null;
	avgTokens: { input: number; output: number } | null;
	validationPassRate: number | null;
};

export function summarizeByCondition(records: readonly TrialRecord[]): ConditionSummary[] {
	const order: string[] = [];
	const grouped = new Map<string, TrialRecord[]>();
	for (const record of records) {
		if (!grouped.has(record.conditionId)) {
			grouped.set(record.conditionId, []);
			order.push(record.conditionId);
		}
		grouped.get(record.conditionId)?.push(record);
	}
	return order.map((conditionId) => {
		const trials = grouped.get(conditionId) ?? [];
		const withEvent = trials.filter((t) => t.event !== null);
		const costs = withEvent
			.map((t) => t.event?.costUsd)
			.filter((c): c is number => typeof c === "number");
		const validations = trials.flatMap((t) => t.artifact?.validations ?? []);
		return {
			conditionId,
			trials: trials.length,
			completed: trials.filter((t) => t.status === "completed").length,
			budgetExceeded: trials.filter((t) => t.status === "budget-exceeded").length,
			crashed: trials.filter((t) => t.status === "crashed").length,
			passRate: ratio(trials.filter((t) => t.verdict.pass).length, trials.length) ?? 0,
			avgCostUsd: average(costs),
			avgDurationMs: average(withEvent.map((t) => t.event?.durationMs ?? 0)),
			avgTurns: average(withEvent.map((t) => t.event?.turns ?? 0)),
			avgToolCalls: average(
				withEvent.map((t) => (t.event?.toolCalls ?? []).reduce((sum, c) => sum + c.calls, 0)),
			),
			avgTokens:
				withEvent.length === 0
					? null
					: {
							input: average(withEvent.map((t) => t.event?.tokens.input ?? 0)) ?? 0,
							output: average(withEvent.map((t) => t.event?.tokens.output ?? 0)) ?? 0,
						},
			validationPassRate: ratio(validations.filter((v) => v.pass).length, validations.length),
		};
	});
}

export function renderReport(summaries: readonly ConditionSummary[]): string {
	if (summaries.length === 0) return "no trial records";
	const baseline = summaries[0];
	const lines: string[] = [];
	for (const s of summaries) {
		lines.push(`condition ${s.conditionId} (${s.trials} trial${s.trials === 1 ? "" : "s"})`);
		lines.push(
			`  outcomes: ${s.completed} completed, ${s.budgetExceeded} budget-exceeded, ${s.crashed} crashed`,
		);
		lines.push(`  verdict pass rate: ${percent(s.passRate)}`);
		if (s.validationPassRate !== null)
			lines.push(`  validation pass rate: ${percent(s.validationPassRate)}`);
		lines.push(
			`  avg: cost ${usd(s.avgCostUsd)}${delta(s.avgCostUsd, baseline?.avgCostUsd, usd)}, duration ${ms(s.avgDurationMs)}${delta(s.avgDurationMs, baseline?.avgDurationMs, ms)}, turns ${num(s.avgTurns)}, tool calls ${num(s.avgToolCalls)}`,
		);
		if (s.avgTokens)
			lines.push(
				`  avg tokens: ${Math.round(s.avgTokens.input)} in / ${Math.round(s.avgTokens.output)} out`,
			);
	}
	return lines.join("\n");

	function delta(
		value: number | null,
		base: number | null | undefined,
		format: (v: number | null) => string,
	): string {
		if (s0(summaries) === undefined) return "";
		if (value === null || base === null || base === undefined) return "";
		if (summaries[0] && value === base) return "";
		const diff = value - base;
		return ` (${diff >= 0 ? "+" : "−"}${format(Math.abs(diff)).trim()} vs ${s0(summaries)})`;
	}
}

function s0(summaries: readonly ConditionSummary[]): string | undefined {
	return summaries[0]?.conditionId;
}

function average(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function ratio(part: number, whole: number): number | null {
	return whole === 0 ? null : part / whole;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function usd(value: number | null): string {
	return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function ms(value: number | null): string {
	if (value === null) return "n/a";
	return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function num(value: number | null): string {
	return value === null ? "n/a" : (Math.round(value * 10) / 10).toString();
}
