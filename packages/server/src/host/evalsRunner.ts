import type {
	EvalCapabilities,
	EvalCondition,
	PiEvent,
	ThinkingLevel,
	WireModel,
} from "@thinkrail/contracts";
import type { CapturedEvent, TrialSessionFactory } from "@thinkrail/evals";
import {
	abortSession,
	createSession,
	listSessionCapabilityCatalog,
	promptSession,
	removeSession,
	type SkillAdmissionContext,
} from "../agent";

const TRIAL_ADMISSION: SkillAdmissionContext = {
	trusted: false,
	acknowledged: [],
	disabled: [],
	disabledGroups: [],
	overrides: {},
};

/** The catalog a trial session at `cwd` would load — mirrors the trial admission context. */
export async function evalCapabilities(cwd: string): Promise<EvalCapabilities> {
	return listSessionCapabilityCatalog(cwd, () => TRIAL_ADMISSION);
}

/** Fail-loud validation of every capability knob a condition carries against the catalog. */
export function assertConditionCapabilities(
	condition: EvalCondition,
	capabilities: EvalCapabilities,
): void {
	const check = (kind: "tools" | "skills" | "extensions", names: readonly string[] | undefined) => {
		if (!names) return;
		const known = new Set(capabilities[kind].map((entry) => entry.id));
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0)
			throw new Error(`Condition ${condition.id}: unknown ${kind} name(s): ${unknown.join(", ")}.`);
	};
	check("tools", condition.tools);
	check("skills", condition.skills);
	check("extensions", condition.extensions);
}

// Record<ThinkingLevel, true> forces exhaustiveness: a level added to pi's union fails here.
const THINKING_LEVEL_FLAGS: Record<ThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};
const THINKING_LEVELS = new Set<string>(Object.keys(THINKING_LEVEL_FLAGS));

const handlers = new Map<string, (event: CapturedEvent) => void>();

export function observeEvalSession(sessionId: string, event: PiEvent): void {
	handlers.get(sessionId)?.(event as unknown as CapturedEvent);
}

export function assertRunnableCondition(condition: EvalCondition): void {
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
		const overrides = await conditionOverrides(cwd, condition);
		if (overrides) input.capabilityOverrides = overrides;
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

export async function conditionOverrides(
	cwd: string,
	condition: {
		id: string;
		tools?: string[];
		skills?: string[];
		extensions?: string[];
		specsAvailable?: boolean;
		promptVariant?: string;
	},
): Promise<NonNullable<Parameters<typeof createSession>[0]["capabilityOverrides"]> | null> {
	const specsOff = condition.specsAvailable === false;
	if (
		!condition.tools &&
		!condition.skills &&
		!condition.extensions &&
		!condition.promptVariant &&
		!specsOff
	)
		return null;
	const excluded = new Set<string>();
	if (condition.tools || condition.skills || condition.extensions) {
		const capabilities = await evalCapabilities(cwd);
		assertConditionCapabilities(condition, capabilities);
		if (condition.extensions) {
			const allowed = new Set(condition.extensions);
			for (const entry of capabilities.extensions)
				if (!allowed.has(entry.id)) excluded.add(entry.id);
		}
	}
	if (specsOff) excluded.add("pi-spec-graph");
	return {
		...(condition.tools ? { tools: condition.tools } : {}),
		...(condition.skills ? { skillsAllowlist: condition.skills } : {}),
		...(excluded.size > 0 ? { excludedExtensionIds: [...excluded] } : {}),
		...(condition.promptVariant ? { systemPromptSuffix: condition.promptVariant } : {}),
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
