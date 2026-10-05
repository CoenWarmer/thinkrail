import type { Condition, FixtureConfig } from "./schemas";

export type ResolvedCondition = Required<Pick<Condition, "id">> & FixtureConfig;

export function resolveCondition(config: FixtureConfig, condition: Condition): ResolvedCondition {
	return {
		id: condition.id,
		specsAvailable: condition.specsAvailable ?? config.specsAvailable,
		...pick("model", condition, config),
		...pick("thinkingLevel", condition, config),
		...pick("tools", condition, config),
		...pick("skills", condition, config),
		...pick("extensions", condition, config),
		...pick("promptVariant", condition, config),
	};
}

function pick<K extends keyof FixtureConfig>(
	key: K,
	condition: Condition,
	config: FixtureConfig,
): Partial<FixtureConfig> {
	const value = (condition as FixtureConfig)[key] ?? config[key];
	return value === undefined ? {} : { [key]: value };
}
