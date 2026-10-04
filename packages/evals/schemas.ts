export type FixtureConfig = {
	model?: string;
	thinkingLevel?: string;
	specsAvailable: boolean;
	skills?: string[];
	promptVariant?: string;
};

export type FixtureUserTurn = {
	text: string;
};

export type FixtureWorkspace = {
	head: string;
	branch: string;
	patchFile?: string;
};

export type Fixture = {
	version: 1;
	id: string;
	createdAt: string;
	source: { sessionId: string; cwd: string };
	workspace: FixtureWorkspace;
	user: { turns: FixtureUserTurn[]; persona?: string };
	config: FixtureConfig;
	reference?: { transcriptFile: string };
};

export type Condition = {
	id: string;
	label?: string;
	model?: string;
	thinkingLevel?: string;
	specsAvailable?: boolean;
	skills?: string[];
	promptVariant?: string;
};

export type BudgetLimits = {
	maxTurns?: number;
	maxToolCalls?: number;
	maxWallMs?: number;
	maxCostUsd?: number;
};

export type Experiment = {
	version: 1;
	id: string;
	fixtureId: string;
	conditions: Condition[];
	trialsPerCondition: number;
	trialBudget: BudgetLimits;
	experimentMaxCostUsd?: number;
};

export type ToolCallCount = {
	tool: string;
	calls: number;
	failures: number;
};

export type EventMetrics = {
	model: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number | null;
	durationMs: number;
	turns: number;
	toolCalls: ToolCallCount[];
	compactionCount: number;
	firstCompactionAtTurn: number | null;
	subagentTasks: string[];
	specToolCalls: number;
};

export type ValidationResult = {
	name: string;
	command: string;
	pass: boolean;
	exitCode: number | null;
};

export type ArtifactMetrics = {
	filesTouched: string[];
	commentsIntroduced: number;
	validations: ValidationResult[];
};

export type JudgeScore = {
	rubric: string;
	score: number;
	max: number;
	rationale: string;
};

export type TrialVerdict = {
	pass: boolean;
	failures: string[];
};

export type TrialStatus = "completed" | "budget-exceeded" | "crashed";

export type TrialRecord = {
	version: 1;
	experimentId: string;
	conditionId: string;
	trial: number;
	sessionId: string;
	startedAt: string;
	endedAt: string;
	status: TrialStatus;
	error?: string;
	event: EventMetrics | null;
	artifact: ArtifactMetrics | null;
	judge?: JudgeScore[];
	verdict: TrialVerdict;
};
