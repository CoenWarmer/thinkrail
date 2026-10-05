import type {
	EvalCapabilities,
	EvalCapabilityEntry,
	EvalCondition,
	EvalExperiment,
	EvalTrialRecord,
	SessionSummary,
} from "@thinkrail/contracts";
import { EVALS_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { aggregateEvalTrials, selectWorkspaceById, useAppStore } from "../store";
import { getTransport } from "../transport";
import { ConfirmDialog } from "./ConfirmDialog";
import {
	ConditionAggregatesTable,
	describeBudget,
	describeCondition,
	ExperimentCompare,
	EVAL_FIELD as FIELD,
	type TrialRef,
	TrialTranscript,
	toTrialRef,
	totalTrialsOf,
} from "./evalsShared";
import { openEvalResults } from "./openEvalResults";

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
	const fail = useCallback(
		(err: unknown) =>
			pushToast({
				variant: "error",
				message: err instanceof Error ? err.message : String(err),
			}),
		[pushToast],
	);

	if (protocolVersion !== null && protocolVersion < EVALS_PROTOCOL_VERSION) {
		return (
			<div className="px-4 py-4 tr-text-metadata text-text-muted">
				This host does not support evals yet.
			</div>
		);
	}

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
	const [watching, setWatching] = useState(false);
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
				<button
					type="button"
					className="text-text-muted underline hover:text-text-default"
					data-testid="eval-active-trial"
					disabled={run.activeTrial.sessionId === ""}
					onClick={() => setWatching(true)}
				>
					active: {run.activeTrial.conditionId}#{run.activeTrial.trial}
					{run.activeTrial.costUsd !== null ? ` — $${run.activeTrial.costUsd.toFixed(4)}` : ""} —
					watch
				</button>
			) : null}
			{watching && run.activeTrial && run.activeTrial.sessionId !== "" ? (
				<TrialTranscriptDialog
					trial={{
						experimentId: run.experimentId,
						conditionId: run.activeTrial.conditionId,
						trial: run.activeTrial.trial,
						sessionId: run.activeTrial.sessionId,
						status: "running",
					}}
					onClose={() => setWatching(false)}
					onError={onError}
				/>
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
			const result = await getTransport().request("session.list", {
				workspaceId,
			});
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
										data-testid="eval-promote-session"
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
	const [editing, setEditing] = useState<EvalExperiment | null>(null);
	return (
		<section>
			<header className="flex items-center justify-between px-4 py-4">
				<h3 className="tr-text-eyebrow">Experiments</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={fixtures.length === 0}
					onClick={() => {
						setEditing(null);
						setComposerOpen(true);
					}}
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
							onEdit={() => {
								setEditing(experiment);
								setComposerOpen(true);
							}}
							onChanged={onChanged}
							onError={onError}
						/>
					))}
				</ul>
			)}
			<ExperimentComposer
				open={composerOpen}
				onOpenChange={(open) => {
					setComposerOpen(open);
					if (!open) setEditing(null);
				}}
				workspaceId={workspaceId}
				fixtures={fixtures}
				initial={editing}
				onSaved={() => {
					setComposerOpen(false);
					setEditing(null);
					onChanged();
				}}
				onError={onError}
			/>
		</section>
	);
}

function ExperimentRow({
	workspaceId,
	experiment,
	runActive,
	onEdit,
	onChanged,
	onError,
}: {
	workspaceId: string;
	experiment: EvalExperiment;
	runActive: boolean;
	onEdit: () => void;
	onChanged: () => void;
	onError: (err: unknown) => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const setEvalTrials = useAppStore((s) => s.setEvalTrials);

	const trials = useAppStore((s) => s.evalTrialsByExperiment[experiment.id]);
	const aggregates = useMemo(() => aggregateEvalTrials(trials ?? []), [trials]);
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
			openEvalResults(workspaceId, experiment.id);
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
						— {experiment.conditions.map(describeCondition).join(" · ")} ×{" "}
						{experiment.trialsPerCondition}
					</span>
				</button>
				<div className="flex items-center gap-4">
					<Button
						variant="outline"
						size="sm"
						onClick={() => openEvalResults(workspaceId, experiment.id)}
						data-testid={`eval-results-${experiment.id}`}
					>
						Results
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={runActive}
						onClick={onEdit}
						data-testid={`eval-edit-${experiment.id}`}
					>
						Edit
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={runActive}
						onClick={() => setDeleteOpen(true)}
						data-testid={`eval-delete-${experiment.id}`}
					>
						Delete
					</Button>
					<Button
						size="sm"
						disabled={runActive}
						onClick={() => setConfirmOpen(true)}
						data-testid={`eval-run-${experiment.id}`}
					>
						Run…
					</Button>
				</div>
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
					<ConditionAggregatesTable aggregates={aggregates} />
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
					trial={toTrialRef(experiment.id, inspecting)}
					onClose={() => setInspecting(null)}
					onError={onError}
				/>
			) : null}
			{comparing ? (
				<CompareDialog
					experiment={experiment}
					onClose={() => setComparing(false)}
					onError={onError}
				/>
			) : null}
			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={`Delete ${experiment.id}?`}
				description="The experiment definition is removed. Recorded trials stay in the trial history."
				confirmLabel="Delete"
				onConfirm={async () => {
					setDeleteOpen(false);
					try {
						await getTransport().request("eval.deleteExperiment", {
							workspaceId,
							experimentId: experiment.id,
						});
						onChanged();
					} catch (err) {
						onError(err);
					}
				}}
			/>
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

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SPEC_GRAPH_SKILL = "spec-graph";

let draftCounter = 0;

interface ConditionDraft {
	key: string;
	id: string;
	model: string;
	thinkingLevel: string;
	promptVariant: string;
	specsAvailable: boolean;
	/** null = inherit the session default (everything). */
	tools: string[] | null;
	skills: string[] | null;
	extensions: string[] | null;
}

function emptyDraft(id: string): ConditionDraft {
	return {
		key: `draft-${++draftCounter}`,
		id,
		model: "",
		thinkingLevel: "",
		promptVariant: "",
		specsAvailable: true,
		tools: null,
		skills: null,
		extensions: null,
	};
}

function toCondition(draft: ConditionDraft): EvalCondition {
	return {
		id: draft.id.trim(),
		...(draft.model.trim() ? { model: draft.model.trim() } : {}),
		...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
		...(draft.promptVariant.trim() ? { promptVariant: draft.promptVariant } : {}),
		...(draft.specsAvailable ? {} : { specsAvailable: false }),
		...(draft.tools ? { tools: draft.tools } : {}),
		...(draft.skills ? { skills: draft.skills } : {}),
		...(draft.extensions ? { extensions: draft.extensions } : {}),
	};
}

function CapabilityChecklist({
	label,
	entries,
	value,
	onChange,
	testId,
}: {
	label: string;
	entries: EvalCapabilityEntry[];
	value: string[] | null;
	onChange: (next: string[] | null) => void;
	testId: string;
}) {
	const customized = value !== null;
	const checked = new Set(value ?? entries.map((entry) => entry.id));
	return (
		<div className="flex flex-col gap-2">
			<label className="flex items-center gap-4">
				<input
					type="checkbox"
					checked={customized}
					onChange={(e) => onChange(e.target.checked ? entries.map((entry) => entry.id) : null)}
					data-testid={`${testId}-customize`}
				/>
				<span>
					{label} {customized ? `(${checked.size}/${entries.length})` : "(inherit all)"}
				</span>
			</label>
			{customized ? (
				<ul className="flex max-h-[9rem] flex-col gap-2 overflow-y-auto pl-12">
					{entries.map((entry) => (
						<li key={entry.id}>
							<label className="flex items-center gap-4" title={entry.description ?? ""}>
								<input
									type="checkbox"
									checked={checked.has(entry.id)}
									onChange={(e) => {
										const next = new Set(checked);
										if (e.target.checked) next.add(entry.id);
										else next.delete(entry.id);
										onChange(entries.map((c) => c.id).filter((id) => next.has(id)));
									}}
									data-testid={`${testId}-${entry.id}`}
								/>
								<span className="truncate">{entry.id}</span>
							</label>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function ConditionEditor({
	draft,
	capabilities,
	modelOptions,
	removable,
	onChange,
	onRemove,
	index,
}: {
	draft: ConditionDraft;
	capabilities: EvalCapabilities | null;
	modelOptions: string[];
	removable: boolean;
	onChange: (next: ConditionDraft) => void;
	onRemove: () => void;
	index: number;
}) {
	const set = (patch: Partial<ConditionDraft>) => onChange({ ...draft, ...patch });
	const knownModel = draft.model === "" || modelOptions.includes(draft.model);
	return (
		<div
			className="flex flex-col gap-8 rounded-[var(--radius-sm)] border border-control-border-default px-8 py-8"
			data-testid={`eval-condition-${index}`}
		>
			<div className="flex items-center gap-8">
				<input
					className={FIELD}
					value={draft.id}
					onChange={(e) => set({ id: e.target.value })}
					placeholder="condition name"
					data-testid={`eval-condition-${index}-id`}
				/>
				{removable ? (
					<Button variant="outline" size="sm" onClick={onRemove}>
						Remove
					</Button>
				) : null}
			</div>
			<div className="flex gap-8">
				{modelOptions.length > 0 ? (
					<label className="flex flex-1 flex-col gap-2">
						Model
						<select
							className={FIELD}
							value={draft.model}
							onChange={(e) => set({ model: e.target.value })}
							data-testid={`eval-condition-${index}-model`}
						>
							<option value="">baseline</option>
							{knownModel ? null : <option value={draft.model}>{draft.model} (unavailable)</option>}
							{modelOptions.map((model) => (
								<option key={model} value={model}>
									{model}
								</option>
							))}
						</select>
					</label>
				) : (
					<label className="flex flex-1 flex-col gap-2">
						Model
						<input
							className={FIELD}
							value={draft.model}
							onChange={(e) => set({ model: e.target.value })}
							placeholder="provider/id (empty = baseline)"
						/>
					</label>
				)}
				<label className="flex flex-1 flex-col gap-2">
					Thinking level
					<select
						className={FIELD}
						value={draft.thinkingLevel}
						onChange={(e) => set({ thinkingLevel: e.target.value })}
					>
						<option value="">baseline</option>
						{THINKING_LEVELS.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>
			</div>
			<label className="flex flex-col gap-2">
				System prompt suffix (empty = none)
				<textarea
					className={`${FIELD} h-56 py-4`}
					value={draft.promptVariant}
					onChange={(e) => set({ promptVariant: e.target.value })}
					data-testid={`eval-condition-${index}-prompt`}
				/>
			</label>
			<label className="flex items-center gap-4">
				<input
					type="checkbox"
					checked={draft.specsAvailable}
					onChange={(e) => {
						const specsAvailable = e.target.checked;
						set({
							specsAvailable,
							...(!specsAvailable && draft.skills
								? {
										skills: draft.skills.filter((name) => name !== SPEC_GRAPH_SKILL),
									}
								: {}),
						});
					}}
					data-testid={`eval-condition-${index}-specs`}
				/>
				<span>Specs available (spec tools + guidance)</span>
			</label>
			{capabilities ? (
				<>
					<CapabilityChecklist
						label="Tools"
						entries={capabilities.tools}
						value={draft.tools}
						onChange={(tools) => set({ tools })}
						testId={`eval-condition-${index}-tools`}
					/>
					<CapabilityChecklist
						label="Skills"
						entries={capabilities.skills}
						value={draft.skills}
						onChange={(skills) => set({ skills })}
						testId={`eval-condition-${index}-skills`}
					/>
					<CapabilityChecklist
						label="Extensions"
						entries={capabilities.extensions}
						value={draft.extensions}
						onChange={(extensions) => set({ extensions })}
						testId={`eval-condition-${index}-extensions`}
					/>
				</>
			) : (
				<div className="text-text-muted">Loading capabilities…</div>
			)}
		</div>
	);
}

function draftFromCondition(condition: EvalCondition): ConditionDraft {
	return {
		...emptyDraft(condition.id),
		model: condition.model ?? "",
		thinkingLevel: condition.thinkingLevel ?? "",
		promptVariant: condition.promptVariant ?? "",
		specsAvailable: condition.specsAvailable !== false,
		tools: condition.tools ?? null,
		skills: condition.skills ?? null,
		extensions: condition.extensions ?? null,
	};
}

function ExperimentComposer({
	open,
	onOpenChange,
	workspaceId,
	fixtures,
	initial,
	onSaved,
	onError,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	fixtures: string[];
	initial: EvalExperiment | null;
	onSaved: () => void;
	onError: (err: unknown) => void;
}) {
	const [id, setId] = useState("");
	const [fixtureId, setFixtureId] = useState("");
	const [trials, setTrials] = useState("2");
	const [maxTurns, setMaxTurns] = useState("20");
	const [maxCostUsd, setMaxCostUsd] = useState("1");
	const [conditions, setConditions] = useState<ConditionDraft[]>([emptyDraft("baseline")]);
	const [capabilities, setCapabilities] = useState<EvalCapabilities | null>(null);
	const models = useAppStore((s) => s.models);
	const modelOptions = useMemo(
		() => models.map((model) => `${model.provider}/${model.id}`),
		[models],
	);
	const editing = initial !== null;

	useEffect(() => {
		if (!open) return;
		if (initial) {
			setId(initial.id);
			setFixtureId(initial.fixtureId);
			setTrials(String(initial.trialsPerCondition));
			setMaxTurns(
				initial.trialBudget.maxTurns !== undefined ? String(initial.trialBudget.maxTurns) : "",
			);
			setMaxCostUsd(
				initial.trialBudget.maxCostUsd !== undefined ? String(initial.trialBudget.maxCostUsd) : "",
			);
			setConditions(initial.conditions.map(draftFromCondition));
		} else {
			setId("");
			setFixtureId("");
			setTrials("2");
			setMaxTurns("20");
			setMaxCostUsd("1");
			setConditions([emptyDraft("baseline")]);
		}
	}, [open, initial]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setCapabilities(null);
		getTransport()
			.request("eval.capabilities", { workspaceId })
			.then((result) => {
				if (!cancelled) setCapabilities(result);
			})
			.catch((err) => {
				if (!cancelled) onError(err);
			});
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId, onError]);

	const conditionIds = conditions.map((c) => c.id.trim());
	const conditionsValid =
		conditionIds.every((cid) => cid !== "") && new Set(conditionIds).size === conditionIds.length;

	const save = async () => {
		const experiment: EvalExperiment = {
			id: id.trim(),
			fixtureId: fixtureId || fixtures[0] || "",
			conditions: conditions.map(toCondition),
			trialsPerCondition: Number.parseInt(trials, 10) || 1,
			trialBudget: {
				...(Number.parseInt(maxTurns, 10) > 0 ? { maxTurns: Number.parseInt(maxTurns, 10) } : {}),
				...(Number.parseFloat(maxCostUsd) > 0 ? { maxCostUsd: Number.parseFloat(maxCostUsd) } : {}),
			},
			...(initial?.experimentMaxCostUsd !== undefined
				? { experimentMaxCostUsd: initial.experimentMaxCostUsd }
				: {}),
		};
		try {
			await getTransport().request("eval.saveExperiment", {
				workspaceId,
				experiment,
			});
			onSaved();
		} catch (err) {
			onError(err);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[34rem]">
				<DialogHeader>
					<DialogTitle>{editing ? `Edit ${initial?.id}` : "New experiment"}</DialogTitle>
				</DialogHeader>
				<div className="flex max-h-[65vh] flex-col gap-8 overflow-y-auto tr-text-metadata">
					<label className="flex flex-col gap-2">
						Name
						<input
							className={FIELD}
							value={id}
							disabled={editing}
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
					{conditions.map((draft, index) => (
						<ConditionEditor
							key={draft.key}
							index={index}
							draft={draft}
							capabilities={capabilities}
							modelOptions={modelOptions}
							removable={conditions.length > 1}
							onChange={(next) => setConditions(conditions.map((c, i) => (i === index ? next : c)))}
							onRemove={() => setConditions(conditions.filter((_, i) => i !== index))}
						/>
					))}
					<div>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setConditions([...conditions, emptyDraft(`variant-${conditions.length}`)])
							}
							data-testid="eval-composer-add-condition"
						>
							Add condition…
						</Button>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={!id.trim() || fixtures.length === 0 || !conditionsValid}
						onClick={save}
						data-testid="eval-composer-save"
					>
						{editing ? "Save changes" : "Save experiment"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function TrialTranscriptDialog({
	trial,
	onClose,
	onError,
}: {
	trial: TrialRef;
	onClose: () => void;
	onError: (err: unknown) => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-w-[40rem]">
				<DialogHeader>
					<DialogTitle>
						{trial.conditionId}#{trial.trial} — {trial.status}
						{trial.costUsd != null ? ` — $${trial.costUsd.toFixed(4)}` : ""}
					</DialogTitle>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-y-auto">
					<TrialTranscript trial={trial} onError={onError} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CompareDialog({
	experiment,
	onClose,
	onError,
}: {
	experiment: EvalExperiment;
	onClose: () => void;
	onError: (err: unknown) => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-w-[56rem]">
				<DialogHeader>
					<DialogTitle>Compare conditions</DialogTitle>
				</DialogHeader>
				<ExperimentCompare
					candidates={[experiment]}
					initialExperimentId={experiment.id}
					onError={onError}
				/>
			</DialogContent>
		</Dialog>
	);
}
