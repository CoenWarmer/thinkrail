// The eval.* wire shapes — rationale in SPEC.md § Evals (v77; knobs + capabilities v78; delete v79).

export interface EvalFixtureConfig {
	model?: string;
	thinkingLevel?: string;
	specsAvailable: boolean;
	tools?: string[];
	skills?: string[];
	extensions?: string[];
	/** Literal text appended to the session's system prompt. */
	promptVariant?: string;
}

export interface EvalFixtureSummary {
	id: string;
	createdAt: string;
	source: { sessionId: string; cwd: string };
	workspace: { head: string; branch: string; patchFile?: string };
	userTurns: string[];
	config: EvalFixtureConfig;
}

export interface EvalCondition {
	id: string;
	label?: string;
	model?: string;
	thinkingLevel?: string;
	specsAvailable?: boolean;
	tools?: string[];
	skills?: string[];
	extensions?: string[];
	/** Literal text appended to the session's system prompt. */
	promptVariant?: string;
}

export interface EvalCapabilityEntry {
	id: string;
	description?: string;
}

/** The catalog a trial session would actually load — the composer's checkbox options. */
export interface EvalCapabilities {
	tools: EvalCapabilityEntry[];
	skills: EvalCapabilityEntry[];
	extensions: EvalCapabilityEntry[];
}

export interface EvalBudget {
	maxTurns?: number;
	maxToolCalls?: number;
	maxWallMs?: number;
	maxCostUsd?: number;
}

export interface EvalExperiment {
	id: string;
	fixtureId: string;
	conditions: EvalCondition[];
	trialsPerCondition: number;
	trialBudget: EvalBudget;
	experimentMaxCostUsd?: number;
}

export type EvalTrialStatus = "completed" | "budget-exceeded" | "crashed";

export interface EvalToolCallCount {
	tool: string;
	calls: number;
	failures: number;
}

export interface EvalEventMetrics {
	model: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number | null;
	durationMs: number;
	turns: number;
	toolCalls: EvalToolCallCount[];
	compactionCount: number;
	firstCompactionAtTurn: number | null;
	subagentTasks: string[];
	specToolCalls: number;
}

export interface EvalValidationResult {
	name: string;
	command: string;
	pass: boolean;
	exitCode: number | null;
}

export interface EvalArtifactMetrics {
	filesTouched: string[];
	commentsIntroduced: number;
	validations: EvalValidationResult[];
}

export interface EvalTrialRecord {
	experimentId: string;
	conditionId: string;
	trial: number;
	sessionId: string;
	startedAt: string;
	endedAt: string;
	status: EvalTrialStatus;
	error?: string;
	event: EvalEventMetrics | null;
	artifact: EvalArtifactMetrics | null;
	verdict: { pass: boolean; failures: string[] };
}

export interface EvalActiveTrial {
	conditionId: string;
	trial: number;
	sessionId: string;
	startedAt: string;
	costUsd: number | null;
}

export interface EvalRunState {
	experimentId: string;
	activeTrial: EvalActiveTrial | null;
	spentUsd: number;
	completedTrials: number;
	totalTrials: number;
	stopping: boolean;
}

export interface EvalUpdatePush {
	run: EvalRunState | null;
	trialAppended?: EvalTrialRecord;
}

export interface EvalConfirmedBudget {
	trialBudget: EvalBudget;
	experimentMaxCostUsd?: number;
	totalTrials: number;
}
