import type {
	EvalBudget,
	EvalCondition,
	EvalExperiment,
	EvalTrialRecord,
	TranscriptMessage,
} from "@thinkrail/contracts";
import { useEffect, useState } from "react";
import { Markdown } from "../chat/Markdown";
import type { EvalConditionAggregate } from "../store";
import { aggregateEvalTrials, useAppStore } from "../store";
import { getTransport } from "../transport";

export const EVAL_FIELD =
	"h-28 w-full rounded-[var(--radius-sm)] border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none focus-visible:border-control-border-active";

export function totalTrialsOf(experiment: EvalExperiment): number {
	return experiment.conditions.length * experiment.trialsPerCondition;
}

export function describeCondition(condition: EvalCondition): string {
	const parts: string[] = [];
	if (condition.model) parts.push(condition.model);
	if (condition.thinkingLevel) parts.push(`thinking ${condition.thinkingLevel}`);
	if (condition.tools) parts.push(`${condition.tools.length} tools`);
	if (condition.skills) parts.push(`${condition.skills.length} skills`);
	if (condition.extensions) parts.push(`${condition.extensions.length} extensions`);
	if (condition.specsAvailable === false) parts.push("no specs");
	if (condition.promptVariant) parts.push("prompt suffix");
	return parts.length > 0 ? `${condition.id} (${parts.join(", ")})` : condition.id;
}

export function describeBudget(budget: EvalBudget): string {
	const parts: string[] = [];
	if (budget.maxTurns !== undefined) parts.push(`${budget.maxTurns} turns`);
	if (budget.maxToolCalls !== undefined) parts.push(`${budget.maxToolCalls} tool calls`);
	if (budget.maxWallMs !== undefined) parts.push(`${Math.round(budget.maxWallMs / 1000)}s wall`);
	if (budget.maxCostUsd !== undefined) parts.push(`$${budget.maxCostUsd} cost`);
	return parts.length > 0 ? parts.join(", ") : "no per-trial caps";
}

export type TrialRef = {
	experimentId: string;
	conditionId: string;
	trial: number;
	sessionId: string;
	status: string;
	costUsd?: number | null;
};

export function toTrialRef(experimentId: string, record: EvalTrialRecord): TrialRef {
	return {
		experimentId,
		conditionId: record.conditionId,
		trial: record.trial,
		sessionId: record.sessionId,
		status: record.status,
		costUsd: record.event?.costUsd ?? null,
	};
}

export function ConditionAggregatesTable({
	aggregates,
}: {
	aggregates: readonly EvalConditionAggregate[];
}) {
	if (aggregates.length === 0)
		return <div className="tr-text-metadata text-text-muted">No trials recorded yet.</div>;
	return (
		<table className="w-full tr-text-metadata">
			<thead>
				<tr className="text-left text-text-muted">
					<th>condition</th>
					<th>trials</th>
					<th>pass</th>
					<th>avg cost</th>
					<th>avg turns</th>
				</tr>
			</thead>
			<tbody>
				{aggregates.map((row) => (
					<tr key={row.conditionId}>
						<td>{row.conditionId}</td>
						<td>{row.trials}</td>
						<td>{row.passRate === null ? "—" : `${Math.round(row.passRate * 100)}%`}</td>
						<td>{row.avgCostUsd === null ? "—" : `$${row.avgCostUsd.toFixed(4)}`}</td>
						<td>{row.avgTurns === null ? "—" : Math.round(row.avgTurns * 10) / 10}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** Trials for one experiment: store-first, with a one-shot lazy `eval.trials` read when absent. */
export function useExperimentTrials(
	experimentId: string,
	onError: (err: unknown) => void,
): EvalTrialRecord[] {
	const trials = useAppStore((s) =>
		experimentId ? s.evalTrialsByExperiment[experimentId] : undefined,
	);
	const missing = experimentId !== "" && trials === undefined;
	useEffect(() => {
		if (!missing) return;
		let cancelled = false;
		getTransport()
			.request("eval.trials", { experimentId })
			.then((result) => {
				if (!cancelled) useAppStore.getState().setEvalTrials(experimentId, result.trials);
			})
			.catch((err) => {
				if (!cancelled) onError(err);
			});
		return () => {
			cancelled = true;
		};
	}, [missing, experimentId, onError]);
	return trials ?? [];
}

type CompareSelection = { experimentId: string; conditionId: string };

function conditionOptions(
	experiment: EvalExperiment | undefined,
	trials: EvalTrialRecord[],
): string[] {
	const ids = new Set<string>(experiment?.conditions.map((c) => c.id) ?? []);
	for (const trial of trials) ids.add(trial.conditionId);
	return [...ids];
}

/**
 * Two (experiment, condition) columns side by side. `candidates` must share one fixture — the
 * caller enforces that; cross-fixture comparison is apples-to-oranges by the evals model.
 */
export function ExperimentCompare({
	candidates,
	initialExperimentId,
	transcriptMaxHeightClass = "max-h-[45vh]",
	onError,
}: {
	candidates: EvalExperiment[];
	initialExperimentId: string;
	transcriptMaxHeightClass?: string;
	onError: (err: unknown) => void;
}) {
	const initial = candidates.find((e) => e.id === initialExperimentId) ?? candidates[0];
	const [left, setLeft] = useState<CompareSelection>({
		experimentId: initial?.id ?? "",
		conditionId: initial?.conditions[0]?.id ?? "",
	});
	const [right, setRight] = useState<CompareSelection>({
		experimentId: initial?.id ?? "",
		conditionId: initial?.conditions[1]?.id ?? initial?.conditions[0]?.id ?? "",
	});
	const leftTrials = useExperimentTrials(left.experimentId, onError);
	const rightTrials = useExperimentTrials(right.experimentId, onError);

	const sideData = (selection: CompareSelection, trials: EvalTrialRecord[]) => {
		const aggregate = aggregateEvalTrials(trials).find(
			(a) => a.conditionId === selection.conditionId,
		);
		const latest = [...trials].reverse().find((t) => t.conditionId === selection.conditionId);
		return { aggregate, latest };
	};
	const l = sideData(left, leftTrials);
	const r = sideData(right, rightTrials);
	const delta =
		l.aggregate?.avgCostUsd != null && r.aggregate?.avgCostUsd != null
			? r.aggregate.avgCostUsd - l.aggregate.avgCostUsd
			: null;
	const crossExperiment = candidates.length > 1;
	const label = (selection: CompareSelection) =>
		crossExperiment && left.experimentId !== right.experimentId
			? `${selection.experimentId}/${selection.conditionId}`
			: selection.conditionId;

	return (
		<div className="flex flex-col gap-8">
			{delta !== null ? (
				<div className="tr-text-metadata text-text-muted">
					avg cost delta ({label(right)} vs {label(left)}): {delta >= 0 ? "+" : "−"}$
					{Math.abs(delta).toFixed(4)}
				</div>
			) : null}
			<div className="grid grid-cols-2 gap-12">
				{[
					{ selection: left, set: setLeft, data: l, trials: leftTrials, key: "left" },
					{ selection: right, set: setRight, data: r, trials: rightTrials, key: "right" },
				].map((column) => {
					const experiment = candidates.find((e) => e.id === column.selection.experimentId);
					const conditions = conditionOptions(experiment, column.trials);
					return (
						<div key={column.key} className="flex min-w-0 flex-col gap-4">
							{crossExperiment ? (
								<select
									className={EVAL_FIELD}
									value={column.selection.experimentId}
									onChange={(e) => {
										const next = candidates.find((c) => c.id === e.target.value);
										column.set({
											experimentId: e.target.value,
											conditionId: next?.conditions[0]?.id ?? "",
										});
									}}
									data-testid={`eval-compare-experiment-${column.key}`}
								>
									{candidates.map((candidate) => (
										<option key={candidate.id} value={candidate.id}>
											{candidate.id}
										</option>
									))}
								</select>
							) : null}
							<select
								className={EVAL_FIELD}
								value={column.selection.conditionId}
								onChange={(e) => column.set({ ...column.selection, conditionId: e.target.value })}
								data-testid={`eval-compare-condition-${column.key}`}
							>
								{conditions.map((id) => (
									<option key={id} value={id}>
										{id}
									</option>
								))}
							</select>
							{column.data.aggregate ? (
								<div className="tr-text-metadata text-text-muted">
									{column.data.aggregate.trials} trials ·{" "}
									{column.data.aggregate.passRate === null
										? "—"
										: `${Math.round(column.data.aggregate.passRate * 100)}% pass`}{" "}
									·{" "}
									{column.data.aggregate.avgCostUsd === null
										? "—"
										: `$${column.data.aggregate.avgCostUsd.toFixed(4)} avg`}
								</div>
							) : null}
							<div className={`${transcriptMaxHeightClass} overflow-y-auto`}>
								{column.data.latest ? (
									<TrialTranscript
										trial={toTrialRef(column.selection.experimentId, column.data.latest)}
										onError={onError}
									/>
								) : (
									<div className="tr-text-metadata text-text-muted">No trials.</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function TrialTranscript({
	trial,
	onError,
}: {
	trial: TrialRef;
	onError: (err: unknown) => void;
}) {
	const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
	const live = useAppStore(
		(s) => s.evalRun?.activeTrial?.sessionId === trial.sessionId && trial.sessionId !== "",
	);
	const liveTick = useAppStore((s) =>
		live ? (s.evalRun?.activeTrial?.costUsd ?? 0) + (s.evalRun?.completedTrials ?? 0) : 0,
	);

	useEffect(() => {
		let cancelled = false;
		getTransport()
			.request("eval.trialMessages", {
				experimentId: trial.experimentId,
				conditionId: trial.conditionId,
				trial: trial.trial,
				sessionId: trial.sessionId,
			})
			.then((result) => {
				if (!cancelled) setMessages(result.messages);
			})
			.catch((err) => {
				if (!cancelled) onError(err);
			});
		return () => {
			cancelled = true;
		};
	}, [trial.experimentId, trial.conditionId, trial.trial, trial.sessionId, onError, liveTick]);

	if (messages === null)
		return <div className="tr-text-metadata text-text-muted">Loading transcript…</div>;
	return (
		<div className="flex flex-col gap-8">
			{live ? <div className="tr-text-metadata text-text-muted">live — updating…</div> : null}
			{messages.map((message, index) => (
				<TranscriptBlock key={`${index}-${message.role}`} message={message} />
			))}
		</div>
	);
}

function TranscriptBlock({ message }: { message: TranscriptMessage }) {
	if (message.role === "user" || message.role === "assistant") {
		const text = transcriptText(message.content);
		const tools =
			message.role === "assistant" && Array.isArray(message.content)
				? message.content.filter(
						(block: { type?: string }) => (block as { type?: string }).type === "toolCall",
					)
				: [];
		if (!text.trim() && tools.length === 0) return null;
		return (
			<div className="tr-text-metadata">
				<div className="tr-text-eyebrow text-text-muted">{message.role}</div>
				{text.trim() ? <Markdown text={text} /> : null}
				{tools.map((tool, i) => (
					<div key={`${i}-${(tool as { name?: string }).name}`} className="text-text-muted">
						→ {(tool as { name?: string }).name}
					</div>
				))}
			</div>
		);
	}
	return null;
}

function transcriptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: { type?: string }) => block.type === "text")
		.map((block: { text?: string }) => block.text ?? "")
		.join("\n");
}
