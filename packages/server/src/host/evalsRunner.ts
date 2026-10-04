import type { PiEvent, ThinkingLevel, WireModel } from "@thinkrail/contracts";
import type { CapturedEvent, TrialSessionFactory } from "@thinkrail/evals";
import { abortSession, createSession, promptSession, removeSession } from "../agent";

const THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] satisfies ThinkingLevel[]);

const handlers = new Map<string, (event: CapturedEvent) => void>();

export function observeEvalSession(sessionId: string, event: PiEvent): void {
	handlers.get(sessionId)?.(event as unknown as CapturedEvent);
}

export function assertRunnableCondition(condition: {
	id: string;
	model?: string;
	thinkingLevel?: string;
}): void {
	if (condition.model) parseModel(condition.model);
	if (condition.thinkingLevel && !THINKING_LEVELS.has(condition.thinkingLevel))
		throw new Error(
			`Condition ${condition.id}: "${condition.thinkingLevel}" is not a pi thinking level.`,
		);
}

export function trialSessionFactory(experimentId: string): TrialSessionFactory {
	let counter = 0;
	return async ({ cwd, condition, onEvent }) => {
		assertRunnableCondition(condition);
		const input: Parameters<typeof createSession>[0] = {
			cwd,
			workspaceId: `eval:${experimentId}:${++counter}`,
		};
		if (condition.model) input.model = parseModel(condition.model);
		if (condition.thinkingLevel && THINKING_LEVELS.has(condition.thinkingLevel))
			input.thinkingLevel = condition.thinkingLevel as ThinkingLevel;
		const created = await createSession(input);
		handlers.set(created.sessionId, onEvent);
		return {
			sessionId: created.sessionId,
			prompt: async (text: string) => {
				await promptSession(created.sessionId, text);
			},
			abort: () => {
				void abortSession(created.sessionId).catch(() => {});
			},
			dispose: async () => {
				handlers.delete(created.sessionId);
				await removeSession(created.sessionId);
			},
		};
	};
}

// a lookup reference: createSession's resolver matches provider+id only
function parseModel(model: string): WireModel {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1)
		throw new Error(`Model "${model}" is not provider/id.`);
	const id = model.slice(slash + 1);
	return {
		provider: model.slice(0, slash),
		id,
		name: id,
		contextWindow: 0,
		reasoning: false,
		thinkingLevels: [],
	};
}
