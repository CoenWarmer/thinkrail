import type { EvalTrialRecord } from "@thinkrail/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { aggregateEvalTrials, selectWorkspaceById, useAppStore } from "../store";
import { getTransport } from "../transport";
import {
	ConditionAggregatesTable,
	describeBudget,
	describeCondition,
	ExperimentCompare,
	TrialTranscript,
	toTrialRef,
} from "./evalsShared";
import { fetchProjectEvals } from "./useProjectEvals";

export default function EvalResultsPane({
	workspaceId,
	experimentId,
}: {
	workspaceId: string;
	experimentId: string;
}) {
	const workspace = useAppStore((s) => selectWorkspaceById(s, workspaceId));
	const projectId = workspace?.projectId ?? null;
	const projectExperiments = useAppStore((s) =>
		projectId ? s.evalsByProject[projectId]?.experiments : undefined,
	);
	const experiment = projectExperiments?.find((e) => e.id === experimentId) ?? null;
	const compareCandidates = useMemo(
		() =>
			experiment
				? (projectExperiments ?? []).filter((e) => e.fixtureId === experiment.fixtureId)
				: [],
		[projectExperiments, experiment],
	);
	const trials = useAppStore((s) => s.evalTrialsByExperiment[experimentId]);
	const run = useAppStore((s) => (s.evalRun?.experimentId === experimentId ? s.evalRun : null));
	const pushToast = useAppStore((s) => s.pushToast);
	const [loaded, setLoaded] = useState(false);

	const onError = useCallback(
		(err: unknown) =>
			pushToast({ variant: "error", message: err instanceof Error ? err.message : String(err) }),
		[pushToast],
	);

	useEffect(() => {
		let cancelled = false;
		fetchProjectEvals(workspaceId).catch(() => {});
		getTransport()
			.request("eval.trials", { experimentId })
			.then((result) => {
				if (cancelled) return;
				useAppStore.getState().setEvalTrials(experimentId, result.trials);
				setLoaded(true);
			})
			.catch((err) => {
				if (cancelled) return;
				setLoaded(true);
				pushToast({
					variant: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, experimentId, pushToast]);

	const records = useMemo(() => trials ?? [], [trials]);
	const aggregates = useMemo(() => aggregateEvalTrials(records), [records]);

	return (
		<div
			className="flex h-full min-h-0 flex-col gap-12 overflow-y-auto px-16 py-12"
			data-testid="eval-results-pane"
		>
			<header className="flex flex-col gap-4">
				<h2 className="tr-text-emphasis">{experimentId}</h2>
				{experiment ? (
					<div className="tr-text-metadata text-text-muted">
						fixture <strong>{experiment.fixtureId}</strong> ·{" "}
						{experiment.conditions.map(describeCondition).join(" · ")} ×{" "}
						{experiment.trialsPerCondition} · budget {describeBudget(experiment.trialBudget)}
						{experiment.experimentMaxCostUsd !== undefined
							? ` · cap $${experiment.experimentMaxCostUsd}`
							: ""}
					</div>
				) : loaded ? (
					<div className="tr-text-metadata text-text-muted">
						This experiment is not part of the current project.
					</div>
				) : (
					<div className="tr-text-metadata text-text-muted">Loading…</div>
				)}
				{run ? <RunStatus run={run} onError={onError} /> : null}
			</header>
			<section>
				<h3 className="pb-4 tr-text-eyebrow">Conditions</h3>
				<ConditionAggregatesTable aggregates={aggregates} />
			</section>
			{records.length > 0 ? (
				<TrialsSection experimentId={experimentId} records={records} onError={onError} />
			) : null}
			{experiment && (aggregates.length > 1 || compareCandidates.length > 1) ? (
				<section>
					<h3 className="pb-4 tr-text-eyebrow">
						{compareCandidates.length > 1
							? "Compare (same-fixture experiments)"
							: "Compare conditions"}
					</h3>
					<ExperimentCompare
						candidates={compareCandidates.length > 0 ? compareCandidates : [experiment]}
						initialExperimentId={experimentId}
						transcriptMaxHeightClass="max-h-[24rem]"
						onError={onError}
					/>
				</section>
			) : null}
		</div>
	);
}

function RunStatus({
	run,
	onError,
}: {
	run: NonNullable<ReturnType<typeof useAppStore.getState>["evalRun"]>;
	onError: (err: unknown) => void;
}) {
	return (
		<div
			className="flex items-center justify-between rounded-[var(--radius-sm)] border border-control-border-default bg-control-bg px-8 py-4 tr-text-metadata"
			data-testid="eval-results-run-status"
		>
			<span>
				running — {run.completedTrials}/{run.totalTrials} trials · ${run.spentUsd.toFixed(4)} spent
				{run.activeTrial
					? ` · active: ${run.activeTrial.conditionId}#${run.activeTrial.trial}`
					: ""}
				{run.stopping ? " · stopping" : ""}
			</span>
			<Button
				variant="outline"
				size="sm"
				onClick={() =>
					getTransport().request("eval.stop", { experimentId: run.experimentId }).catch(onError)
				}
			>
				Stop
			</Button>
		</div>
	);
}

function TrialsSection({
	experimentId,
	records,
	onError,
}: {
	experimentId: string;
	records: EvalTrialRecord[];
	onError: (err: unknown) => void;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const selectedRecord =
		records.find((trial) => `${trial.conditionId}#${trial.trial}` === selected) ?? null;

	return (
		<section className="flex min-h-0 flex-col">
			<h3 className="pb-4 tr-text-eyebrow">Trials</h3>
			<div className="grid grid-cols-[minmax(12rem,1fr)_2fr] gap-12">
				<ul className="flex max-h-[24rem] flex-col overflow-y-auto">
					{records.map((trial) => {
						const key = `${trial.conditionId}#${trial.trial}`;
						return (
							<li key={key}>
								<button
									type="button"
									className={`w-full py-2 text-left tr-text-metadata hover:text-text-default ${
										selected === key ? "text-text-default" : "text-text-muted"
									}`}
									onClick={() => setSelected(key)}
									data-testid={`eval-results-trial-${trial.conditionId}-${trial.trial}`}
								>
									{key} — {trial.status}
									{trial.verdict.pass ? "" : " (failed)"}
									{trial.event?.costUsd != null ? ` — $${trial.event.costUsd.toFixed(4)}` : ""}
								</button>
							</li>
						);
					})}
				</ul>
				<div className="max-h-[24rem] min-w-0 overflow-y-auto">
					{selectedRecord ? (
						<TrialTranscript trial={toTrialRef(experimentId, selectedRecord)} onError={onError} />
					) : (
						<div className="tr-text-metadata text-text-muted">
							Select a trial to read its transcript.
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
