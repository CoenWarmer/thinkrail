import type {
	EvalBudget,
	EvalCondition,
	EvalExperiment,
	EvalTrialRecord,
	SessionSummary,
	TranscriptMessage,
} from "@thinkrail/contracts";
import { EVALS_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "../chat/Markdown";
import { selectEvalConditionAggregates, selectWorkspaceById, useAppStore } from "../store";
import { getTransport } from "../transport";
import { ConfirmDialog } from "./ConfirmDialog";

const FIELD =
	"h-28 w-full rounded-[var(--radius-sm)] border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none focus-visible:border-control-border-active";

export function EvalsPanel({
	workspaceId,
	failed,
	onRetry,
}: {
	workspaceId: string;
	failed?: boolean;
	onRetry: () => void;
}) {
	const protocolVersion = useAppStore((s) => s.protocolVersion);
	const workspace = useAppStore((s) => selectWorkspaceById(s, workspaceId));
	const projectId = workspace?.projectId ?? null;
	const evals = useAppStore((s) => (projectId ? s.evalsByProject[projectId] : undefined));
	const run = useAppStore((s) => s.evalRun);
	const pushToast = useAppStore((s) => s.pushToast);

	if (protocolVersion !== null && protocolVersion < EVALS_PROTOCOL_VERSION) {
		return (
			<div className="px-4 py-4 tr-text-metadata text-text-muted">
				This host does not support evals yet.
			</div>
		);
	}

	const fail = (err: unknown) =>
		pushToast({ variant: "error", message: err instanceof Error ? err.message : String(err) });

	return (
		<div className="flex min-h-0 flex-col gap-12" data-testid="evals-panel">
			{failed ? (
				<div className="rounded-[var(--radius-sm)] border border-feedback-error-muted bg-feedback-error-subtle px-8 py-4 tr-text-metadata">
					Evals failed to load.{" "}
					<button type="button" className="underline" onClick={onRetry}>
						Retry
					</button>
				</div>
			) : null}
			{run ? <RunBanner run={run} onError={fail} /> : null}
			<FixtureSection
				workspaceId={workspaceId}
				fixtures={evals?.fixtures ?? []}
				onChanged={onRetry}
				onError={fail}
			/>
			<ExperimentSection
				workspaceId={workspaceId}
				experiments={evals?.experiments ?? []}
				fixtures={(evals?.fixtures ?? []).map((f) => f.id)}
				runActive={run !== null}
				onChanged={onRetry}
				onError={fail}
			/>
		</div>
	);
}

function RunBanner({
	run,
	onError,
}: {
	run: NonNullable<ReturnType<typeof useAppStore.getState>["evalRun"]>;
	onError: (err: unknown) => void;
}) {
	return (
		<div
			className="rounded-[var(--radius-sm)] border border-control-border-default bg-control-bg px-8 py-8 tr-text-metadata"
			data-testid="eval-run-banner"
		>
			<div className="flex items-center justify-between">
				<span>
					Running <strong>{run.experimentId}</strong> — {run.completedTrials}/{run.totalTrials}{" "}
					trials, ${run.spentUsd.toFixed(4)} spent
					{run.stopping ? " (stopping)" : ""}
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
			{run.activeTrial ? (
				<div className="text-text-muted">
					active: {run.activeTrial.conditionId}#{run.activeTrial.trial}
					{run.activeTrial.costUsd !== null ? ` — $${run.activeTrial.costUsd.toFixed(4)}` : ""}
				</div>
			) : null}
		</div>
	);
}

function FixtureSection({
	workspaceId,
	fixtures,
	onChanged,
	onError,
}: {
	workspaceId: string;
	fixtures: { id: string; createdAt: string; userTurns: string[] }[];
	onChanged: () => void;
	onError: (err: unknown) => void;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

	const openPicker = async () => {
		setPickerOpen(true);
		setSessions(null);
		try {
			const result = await getTransport().request("session.list", { workspaceId });
			setSessions(result);
		} catch (err) {
			setPickerOpen(false);
			onError(err);
		}
	};

	const promote = async (sessionId: string) => {
		try {
			await getTransport().request("eval.promote", { workspaceId, sessionId });
			setPickerOpen(false);
			onChanged();
		} catch (err) {
			onError(err);
		}
	};

	return (
		<section>
			<header className="flex items-center justify-between px-4 py-4">
				<h3 className="tr-text-eyebrow">Fixtures</h3>
				<Button variant="outline" size="sm" onClick={openPicker} data-testid="eval-promote-open">
					Promote a session…
				</Button>
			</header>
			{fixtures.length === 0 ? (
				<div className="px-4 py-4 tr-text-metadata text-text-muted">
					No fixtures yet. Promote a past session to replay it as an experiment.
				</div>
			) : (
				<ul className="flex flex-col">
					{fixtures.map((fixture) => (
						<li key={fixture.id} className="px-4 py-4 tr-text-metadata">
							<strong>{fixture.id}</strong> — {fixture.userTurns.length} turn
							{fixture.userTurns.length === 1 ? "" : "s"},{" "}
							{new Date(fixture.createdAt).toLocaleDateString()}
						</li>
					))}
				</ul>
			)}
			<Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
				<DialogContent className="max-w-[28rem]">
					<DialogHeader>
						<DialogTitle>Promote a session to a fixture</DialogTitle>
					</DialogHeader>
					{sessions === null ? (
						<div className="tr-text-metadata text-text-muted">Loading sessions…</div>
					) : sessions.length === 0 ? (
						<div className="tr-text-metadata text-text-muted">No sessions in this workspace.</div>
					) : (
						<ul className="flex max-h-[18rem] flex-col gap-4 overflow-y-auto">
							{sessions.map((session) => (
								<li key={session.sessionId}>
									<button
										type="button"
										className="w-full rounded-[var(--radius-sm)] border border-control-border-default bg-control-bg px-8 py-4 text-left tr-text-metadata hover:border-control-border-active"
										onClick={() => promote(session.sessionId)}
									>
										{session.title || session.sessionId}
									</button>
								</li>
							))}
						</ul>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}

function ExperimentSection({
	workspaceId,
	experiments,
	fixtures,
	runActive,
	onChanged,
	onError,
}: {
	workspaceId: string;
	experiments: EvalExperiment[];
	fixtures: string[];
	runActive: boolean;
	onChanged: () => void;
	onError: (err: unknown) => void;
}) {
	const [composerOpen, setComposerOpen] = useState(false);
	return (
		<section>
			<header className="flex items-center justify-between px-4 py-4">
				<h3 className="tr-text-eyebrow">Experiments</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={fixtures.length === 0}
					onClick={() => setComposerOpen(true)}
					data-testid="eval-composer-open"
				>
					New experiment…
				</Button>
			</header>
			{experiments.length === 0 ? (
				<div className="px-4 py-4 tr-text-metadata text-text-muted">No experiments yet.</div>
			) : (
				<ul className="flex flex-col gap-8">
					{experiments.map((experiment) => (
						<ExperimentRow
							key={experiment.id}
							workspaceId={workspaceId}
							experiment={experiment}
							runActive={runActive}
							onError={onError}
						/>
					))}
				</ul>
			)}
			<ExperimentComposer
				open={composerOpen}
				onOpenChange={setComposerOpen}
				workspaceId={workspaceId}
				fixtures={fixtures}
				onSaved={() => {
					setComposerOpen(false);
					onChanged();
				}}
				onError={onError}
			/>
		</section>
	);
}

function totalTrialsOf(experiment: EvalExperiment): number {
	return experiment.conditions.length * experiment.trialsPerCondition;
}

function describeBudget(budget: EvalBudget): string {
	const parts: string[] = [];
	if (budget.maxTurns !== undefined) parts.push(`${budget.maxTurns} turns`);
	if (budget.maxToolCalls !== undefined) parts.push(`${budget.maxToolCalls} tool calls`);
	if (budget.maxWallMs !== undefined) parts.push(`${Math.round(budget.maxWallMs / 1000)}s wall`);
	if (budget.maxCostUsd !== undefined) parts.push(`$${budget.maxCostUsd} cost`);
	return parts.length > 0 ? parts.join(", ") : "no per-trial caps";
}

function ExperimentRow({
	workspaceId,
	experiment,
	runActive,
	onError,
}: {
	workspaceId: string;
	experiment: EvalExperiment;
	runActive: boolean;
	onError: (err: unknown) => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const aggregates = useAppStore((s) => selectEvalConditionAggregates(s, experiment.id));
	const setEvalTrials = useAppStore((s) => s.setEvalTrials);

	const trials = useAppStore((s) => s.evalTrialsByExperiment[experiment.id]);
	const [inspecting, setInspecting] = useState<EvalTrialRecord | null>(null);
	const [comparing, setComparing] = useState(false);

	const toggle = async () => {
		const next = !expanded;
		setExpanded(next);
		if (next) {
			try {
				const result = await getTransport().request("eval.trials", {
					experimentId: experiment.id,
				});
				setEvalTrials(experiment.id, result.trials);
			} catch (err) {
				onError(err);
			}
		}
	};

	const start = async () => {
		setConfirmOpen(false);
		try {
			await getTransport().request("eval.run", {
				workspaceId,
				experimentId: experiment.id,
				confirmedBudget: {
					trialBudget: experiment.trialBudget,
					...(experiment.experimentMaxCostUsd !== undefined
						? { experimentMaxCostUsd: experiment.experimentMaxCostUsd }
						: {}),
					totalTrials: totalTrialsOf(experiment),
				},
			});
		} catch (err) {
			onError(err);
		}
	};

	return (
		<li className="rounded-[var(--radius-sm)] border border-control-border-default px-8 py-8">
			<div className="flex items-center justify-between">
				<button type="button" className="text-left tr-text-ui" onClick={toggle}>
					<strong>{experiment.id}</strong>
					<span className="text-text-muted">
						{" "}
						— {experiment.conditions.length} condition
						{experiment.conditions.length === 1 ? "" : "s"} × {experiment.trialsPerCondition}
					</span>
				</button>
				<Button
					size="sm"
					disabled={runActive}
					onClick={() => setConfirmOpen(true)}
					data-testid={`eval-run-${experiment.id}`}
				>
					Run…
				</Button>
			</div>
			{expanded ? (
				<div className="pt-8 tr-text-metadata">
					{aggregates.length > 1 ? (
						<div className="pb-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setComparing(true)}
								data-testid={`eval-compare-${experiment.id}`}
							>
								Compare conditions…
							</Button>
						</div>
					) : null}
					{aggregates.length === 0 ? (
						<div className="text-text-muted">No trials recorded yet.</div>
					) : (
						<table className="w-full">
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
					)}
					{(trials ?? []).length > 0 ? (
						<ul className="flex flex-col pt-4">
							{(trials ?? []).map((trial) => (
								<li key={`${trial.conditionId}-${trial.trial}`}>
									<button
										type="button"
										className="w-full py-2 text-left text-text-muted hover:text-text-default"
										onClick={() => setInspecting(trial)}
										data-testid={`eval-trial-${trial.conditionId}-${trial.trial}`}
									>
										{trial.conditionId}#{trial.trial} — {trial.status}
										{trial.verdict.pass ? "" : " (failed)"}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			{inspecting ? (
				<TrialTranscriptDialog
					experimentId={experiment.id}
					trial={inspecting}
					onClose={() => setInspecting(null)}
					onError={onError}
				/>
			) : null}
			{comparing ? (
				<CompareDialog
					experimentId={experiment.id}
					trials={trials ?? []}
					onClose={() => setComparing(false)}
					onError={onError}
				/>
			) : null}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Run ${experiment.id}?`}
				description={`${totalTrialsOf(experiment)} trial(s) will run real agent sessions and spend real tokens. Per-trial budget: ${describeBudget(experiment.trialBudget)}${experiment.experimentMaxCostUsd !== undefined ? `; experiment cap $${experiment.experimentMaxCostUsd}` : ""}.`}
				confirmLabel="Run and spend"
				onConfirm={start}
			/>
		</li>
	);
}

function ExperimentComposer({
	open,
	onOpenChange,
	workspaceId,
	fixtures,
	onSaved,
	onError,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	fixtures: string[];
	onSaved: () => void;
	onError: (err: unknown) => void;
}) {
	const [id, setId] = useState("");
	const [fixtureId, setFixtureId] = useState("");
	const [trials, setTrials] = useState("2");
	const [maxTurns, setMaxTurns] = useState("20");
	const [maxCostUsd, setMaxCostUsd] = useState("1");
	const [variantModel, setVariantModel] = useState("");
	const [variantThinking, setVariantThinking] = useState("");

	const save = async () => {
		const conditions: EvalCondition[] = [{ id: "baseline" }];
		if (variantModel.trim() || variantThinking) {
			conditions.push({
				id: "variant",
				...(variantModel.trim() ? { model: variantModel.trim() } : {}),
				...(variantThinking ? { thinkingLevel: variantThinking } : {}),
			});
		}
		const experiment: EvalExperiment = {
			id: id.trim(),
			fixtureId: fixtureId || fixtures[0] || "",
			conditions,
			trialsPerCondition: Number.parseInt(trials, 10) || 1,
			trialBudget: {
				...(Number.parseInt(maxTurns, 10) > 0 ? { maxTurns: Number.parseInt(maxTurns, 10) } : {}),
				...(Number.parseFloat(maxCostUsd) > 0 ? { maxCostUsd: Number.parseFloat(maxCostUsd) } : {}),
			},
		};
		try {
			await getTransport().request("eval.saveExperiment", { workspaceId, experiment });
			onSaved();
		} catch (err) {
			onError(err);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[26rem]">
				<DialogHeader>
					<DialogTitle>New experiment</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-8 tr-text-metadata">
					<label className="flex flex-col gap-2">
						Name
						<input
							className={FIELD}
							value={id}
							onChange={(e) => setId(e.target.value)}
							data-testid="eval-composer-id"
						/>
					</label>
					<label className="flex flex-col gap-2">
						Fixture
						<select
							className={FIELD}
							value={fixtureId || fixtures[0] || ""}
							onChange={(e) => setFixtureId(e.target.value)}
						>
							{fixtures.map((f) => (
								<option key={f} value={f}>
									{f}
								</option>
							))}
						</select>
					</label>
					<div className="flex gap-8">
						<label className="flex flex-1 flex-col gap-2">
							Trials per condition
							<input className={FIELD} value={trials} onChange={(e) => setTrials(e.target.value)} />
						</label>
						<label className="flex flex-1 flex-col gap-2">
							Max turns / trial
							<input
								className={FIELD}
								value={maxTurns}
								onChange={(e) => setMaxTurns(e.target.value)}
							/>
						</label>
						<label className="flex flex-1 flex-col gap-2">
							Max $ / trial
							<input
								className={FIELD}
								value={maxCostUsd}
								onChange={(e) => setMaxCostUsd(e.target.value)}
							/>
						</label>
					</div>
					<label className="flex flex-col gap-2">
						Variant model (provider/id — empty to keep the baseline model)
						<input
							className={FIELD}
							value={variantModel}
							onChange={(e) => setVariantModel(e.target.value)}
							placeholder="openrouter/moonshotai/kimi-k2.6"
						/>
					</label>
					<label className="flex flex-col gap-2">
						Variant thinking level (empty to keep the baseline level)
						<select
							className={FIELD}
							value={variantThinking}
							onChange={(e) => setVariantThinking(e.target.value)}
						>
							<option value="">baseline</option>
							{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
								<option key={level} value={level}>
									{level}
								</option>
							))}
						</select>
					</label>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled={!id.trim() || fixtures.length === 0} onClick={save}>
						Save experiment
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function TrialTranscript({
	experimentId,
	trial,
	onError,
}: {
	experimentId: string;
	trial: EvalTrialRecord;
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
				experimentId,
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
	}, [experimentId, trial.conditionId, trial.trial, trial.sessionId, onError, liveTick]);

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

function TrialTranscriptDialog({
	experimentId,
	trial,
	onClose,
	onError,
}: {
	experimentId: string;
	trial: EvalTrialRecord;
	onClose: () => void;
	onError: (err: unknown) => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-w-[40rem]">
				<DialogHeader>
					<DialogTitle>
						{trial.conditionId}#{trial.trial} — {trial.status}
						{trial.event?.costUsd != null ? ` — $${trial.event.costUsd.toFixed(4)}` : ""}
					</DialogTitle>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-y-auto">
					<TrialTranscript experimentId={experimentId} trial={trial} onError={onError} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CompareDialog({
	experimentId,
	trials,
	onClose,
	onError,
}: {
	experimentId: string;
	trials: EvalTrialRecord[];
	onClose: () => void;
	onError: (err: unknown) => void;
}) {
	const aggregates = useAppStore((s) => selectEvalConditionAggregates(s, experimentId));
	const conditionIds = aggregates.map((a) => a.conditionId);
	const [left, setLeft] = useState(conditionIds[0] ?? "");
	const [right, setRight] = useState(conditionIds[1] ?? "");

	const side = (conditionId: string) => {
		const aggregate = aggregates.find((a) => a.conditionId === conditionId);
		const latest = [...trials].reverse().find((t) => t.conditionId === conditionId);
		return { aggregate, latest };
	};
	const l = side(left);
	const r = side(right);
	const delta =
		l.aggregate?.avgCostUsd != null && r.aggregate?.avgCostUsd != null
			? r.aggregate.avgCostUsd - l.aggregate.avgCostUsd
			: null;

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-w-[56rem]">
				<DialogHeader>
					<DialogTitle>Compare conditions</DialogTitle>
				</DialogHeader>
				{delta !== null ? (
					<div className="tr-text-metadata text-text-muted">
						avg cost delta ({right} vs {left}): {delta >= 0 ? "+" : "−"}$
						{Math.abs(delta).toFixed(4)}
					</div>
				) : null}
				<div className="grid grid-cols-2 gap-12">
					{[
						{ id: left, set: setLeft, data: l },
						{ id: right, set: setRight, data: r },
					].map((column, index) => (
						<div key={index === 0 ? "left" : "right"} className="min-w-0">
							<select
								className={FIELD}
								value={column.id}
								onChange={(e) => column.set(e.target.value)}
							>
								{conditionIds.map((id) => (
									<option key={id} value={id}>
										{id}
									</option>
								))}
							</select>
							{column.data.aggregate ? (
								<div className="py-4 tr-text-metadata text-text-muted">
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
							<div className="max-h-[45vh] overflow-y-auto">
								{column.data.latest ? (
									<TrialTranscript
										experimentId={experimentId}
										trial={column.data.latest}
										onError={onError}
									/>
								) : (
									<div className="tr-text-metadata text-text-muted">No trials.</div>
								)}
							</div>
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
