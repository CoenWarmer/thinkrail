import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	createSyntheticSourceInfo,
	DefaultPackageManager,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	type PathMetadata,
	type ResourceDiagnostic,
	type ResourceLoader,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { SkillCatalogEntry, SlashCommandInfo } from "@thinkrail/contracts";
import specGraphExtension from "pi-spec-graph";
import { BUNDLED_EXTENSION_PACKAGES } from "../buildSupport";
import { type BundledTrashHelpers, setBundledTrashHelpers } from "../trash";
import {
	type AskUserQuestionWaiters,
	askUserQuestionExtension,
	createAskUserQuestionWaiters,
} from "./askUserQuestion";
import { oversizedImageGuard } from "./imageGuard";
import { metricsQueryToolExtension } from "./metricsQueryTool";
import { requestReviewExtension } from "./requestReviewTool";
import { reviewToolExtension } from "./reviewTool";
import { decideSkill, type SkillAdmissionContext } from "./skillAdmission";
import {
	type CompatibilitySkillSource,
	candidateCompatibilitySkillRoots,
	discoverCompatibilitySkillSources,
} from "./skillSources";
import { setTitleExtension } from "./titleTool";

export type BundledExtensionFactory = ExtensionFactory;

export interface BundledExtensions {
	factories: BundledExtensionFactory[];
	skillsDir: string;
	trashHelpers: BundledTrashHelpers;
	webAccessFactory: BundledExtensionFactory;
}

let bundled: BundledExtensions | undefined;

export async function registerBundledRuntime(extensions: BundledExtensions): Promise<void> {
	bundled = extensions;
	setBundledTrashHelpers(extensions.trashHelpers);
	const [{ registerBunOAuthFlows }, { bedrockProviderModule }, { setBedrockProviderModule }] =
		await Promise.all([
			import("@earendil-works/pi-ai/bun-oauth"),
			import("@earendil-works/pi-ai/bedrock-provider"),
			import("@earendil-works/pi-ai/compat"),
		]);
	registerBunOAuthFlows();
	setBedrockProviderModule(bedrockProviderModule);
}

let devPaths: { extensionPaths: string[]; skillPaths: string[] } | undefined;
function resolveDevPaths(): { extensionPaths: string[]; skillPaths: string[] } {
	if (devPaths) return devPaths;
	const require = createRequire(import.meta.url);
	const resolved = BUNDLED_EXTENSION_PACKAGES.map((pkg) => ({
		...pkg,
		path: require.resolve(`${pkg.name}/index.ts`),
	}));
	devPaths = {
		extensionPaths: resolved.map((pkg) => pkg.path),
		skillPaths: resolved
			.filter((pkg) => pkg.skills)
			.map((pkg) => join(dirname(pkg.path), "skills")),
	};
	return devPaths;
}

const headlessSearchPolicy: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "web_search") return;
		const input = event.input as Record<string, unknown>;
		if (input.workflow == null) input.workflow = "none";
	});
};

function isUnderPath(path: string, root: string): boolean {
	const normalizedPath = resolve(path);
	const normalizedRoot = resolve(root);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function relabelAliasProvenance(skill: Skill, sources: CompatibilitySkillSource[]): Skill {
	if (skill.sourceInfo.scope !== "temporary") return skill;
	const source = sources.find((candidate) => isUnderPath(skill.filePath, candidate.path));
	if (!source) return skill;
	return {
		...skill,
		sourceInfo: createSyntheticSourceInfo(skill.filePath, {
			source: source.provider,
			scope: source.scope,
			origin: "top-level",
			baseDir: source.path,
		}),
	};
}

function skillGroup(
	filePath: string,
	sources: CompatibilitySkillSource[],
	bundledPaths: string[],
): { group: string; isPlugin: boolean } {
	const source = sources.find((candidate) => isUnderPath(filePath, candidate.path));
	if (source?.plugin) return { group: source.plugin, isPlugin: true };
	if (source?.scope === "project") return { group: "project", isPlugin: false };
	if (source?.scope === "user") return { group: "personal", isPlugin: false };
	if (bundledPaths.some((path) => isUnderPath(filePath, path))) {
		return { group: "bundled", isPlugin: false };
	}
	return { group: "pi", isPlugin: false };
}

function skillsGate(
	cwd: string,
	bundledPaths: string[],
	getCtx: () => SkillAdmissionContext,
	allowlist?: readonly string[],
) {
	const allowed = allowlist === undefined ? null : new Set(allowlist);
	return (current: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		const ctx = getCtx();
		const sources = discoverCompatibilitySkillSources(cwd);
		const projectAliasPaths = sources.filter((s) => s.scope === "project").map((s) => s.path);
		const isProjectAlias = (filePath: string) =>
			projectAliasPaths.some((path) => isUnderPath(filePath, path));
		return {
			...current,
			skills: current.skills
				.map((skill) => relabelAliasProvenance(skill, sources))
				.filter((skill) => {
					if (allowed !== null && !allowed.has(skill.name)) return false;
					const { group, isPlugin } = skillGroup(skill.filePath, sources, bundledPaths);
					return (
						decideSkill(
							{ name: skill.name, isProjectAlias: isProjectAlias(skill.filePath), group, isPlugin },
							ctx,
						) === "load"
					);
				}),
		};
	};
}

function resolveSkillInputs(
	cwd: string,
	getCtx: () => SkillAdmissionContext,
	allowlist?: readonly string[],
): {
	additionalSkillPaths: string[];
	skillsOverride: ReturnType<typeof skillsGate>;
} {
	const candidates = candidateCompatibilitySkillRoots(cwd);
	const personal = candidates.filter((source) => source.scope === "user");
	const project = candidates.filter((source) => source.scope === "project");
	const bundledSkillPaths = bundled ? [bundled.skillsDir] : resolveDevPaths().skillPaths;
	return {
		additionalSkillPaths: [
			...bundledSkillPaths,
			...personal.map((source) => source.path),
			...project.map((source) => source.path),
		],
		skillsOverride: skillsGate(cwd, bundledSkillPaths, getCtx, allowlist),
	};
}

export function toSkillCommands(skills: readonly Skill[]): SlashCommandInfo[] {
	return skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill" as const,
		sourceInfo: skill.sourceInfo,
	}));
}

let devWebAccessFactory: BundledExtensionFactory | undefined;
function webAccessFactory(): BundledExtensionFactory {
	if (bundled) return bundled.webAccessFactory;
	if (!devWebAccessFactory) {
		const require = createRequire(import.meta.url);
		const loaded: { default: BundledExtensionFactory } = require("pi-web-access/index.ts");
		devWebAccessFactory = loaded.default;
	}
	return devWebAccessFactory;
}

export function childExtensionFactories(): ExtensionFactory[] {
	return [headlessSearchPolicy, webAccessFactory(), specGraphExtension];
}

export interface SessionCapabilityOverrides {
	/** Allowlist of skill names; skills outside it are dropped after admission filtering. */
	skillsAllowlist?: readonly string[];
	/** Bundled package names (e.g. "pi-spec-graph") and/or discovered extension paths to exclude. */
	excludedExtensionIds?: readonly string[];
}

const bundledIndexByName = new Map(BUNDLED_EXTENSION_PACKAGES.map((pkg, i) => [pkg.name, i]));

function splitExcludedIds(ids: readonly string[]): {
	bundledIndexes: Set<number>;
	paths: string[];
} {
	const bundledIndexes = new Set<number>();
	const paths: string[] = [];
	for (const id of ids) {
		const index = bundledIndexByName.get(id);
		if (index !== undefined) bundledIndexes.add(index);
		else paths.push(id);
	}
	return { bundledIndexes, paths };
}

export async function buildResourceLoader(
	cwd: string,
	settingsManager: SettingsManager,
	getAdmission: () => SkillAdmissionContext,
	excludedExtensionPaths: readonly string[] = [],
	extraFactories: ExtensionFactory[] = [],
	askUserQuestionWaiters: AskUserQuestionWaiters = createAskUserQuestionWaiters(),
	capabilityOverrides?: SessionCapabilityOverrides,
): Promise<ResourceLoader> {
	const sharedFactories = [
		headlessSearchPolicy,
		askUserQuestionExtension(askUserQuestionWaiters),
		reviewToolExtension,
		metricsQueryToolExtension,
		requestReviewExtension,
		setTitleExtension,
		oversizedImageGuard,
		...extraFactories,
	];
	const { bundledIndexes, paths: overridePaths } = splitExcludedIds(
		capabilityOverrides?.excludedExtensionIds ?? [],
	);
	const skillInputs = resolveSkillInputs(cwd, getAdmission, capabilityOverrides?.skillsAllowlist);
	const agentDir = getAgentDir();
	const common = {
		cwd,
		agentDir,
		settingsManager,
		...skillInputs,
	};

	const resolvedOverridePaths = new Set(overridePaths.map((path) => resolve(cwd, path)));
	const excluded = new Set([
		...excludedExtensionPaths.map((path) => resolve(path)),
		...resolvedOverridePaths,
	]);
	const discoveredExtensionPaths: string[] = [];
	const discoveredMetadata = new Map<string, PathMetadata>();
	if (excluded.size > 0) {
		await settingsManager.reload();
		const resolvedResources = await new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
		}).resolve();
		const enabledPaths = new Set<string>();
		for (const resource of resolvedResources.extensions) {
			if (!resource.enabled) continue;
			enabledPaths.add(resolve(resource.path));
			if (excluded.has(resolve(resource.path))) continue;
			discoveredExtensionPaths.push(resource.path);
			discoveredMetadata.set(resolve(resource.path), resource.metadata);
		}
		const unknown = [...resolvedOverridePaths].filter((path) => !enabledPaths.has(path));
		if (unknown.length > 0)
			throw new Error(
				`Unknown excluded extension id(s): ${unknown.join(", ")} — not a bundled package name or a discovered extension.`,
			);
	}

	const keptByIndex = (_: unknown, i: number) => !bundledIndexes.has(i);
	const additionalExtensionPaths = [
		...(bundled ? [] : resolveDevPaths().extensionPaths.filter(keptByIndex)),
		...discoveredExtensionPaths,
	];
	const loader = new DefaultResourceLoader(
		bundled
			? {
					...common,
					...(excluded.size > 0 ? { noExtensions: true, additionalExtensionPaths } : {}),
					extensionFactories: [...bundled.factories.filter(keptByIndex), ...sharedFactories],
				}
			: {
					...common,
					...(excluded.size > 0 ? { noExtensions: true } : {}),
					additionalExtensionPaths,
					extensionFactories: sharedFactories,
				},
	);
	await loader.reload();

	for (const extension of loader.getExtensions().extensions) {
		const metadata = discoveredMetadata.get(resolve(extension.resolvedPath));
		if (!metadata) continue;
		extension.sourceInfo = createSyntheticSourceInfo(extension.path, metadata);
		for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
		for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo;
	}
	return loader;
}

export interface CapabilityCatalogEntry {
	id: string;
	description?: string;
}

export interface SessionCapabilityCatalog {
	tools: CapabilityCatalogEntry[];
	skills: CapabilityCatalogEntry[];
	extensions: CapabilityCatalogEntry[];
}

const BUILTIN_TOOL_IDS = ["read", "bash", "edit", "write"] as const;

/**
 * What a capability-override-free session at `cwd` would load — the validation and checkbox
 * catalog for eval conditions. Host-service tools (background commands, subagents) are not
 * listed: subagents stay off in eval trials and background_command is session furniture.
 */
export async function listSessionCapabilityCatalog(
	cwd: string,
	getAdmission: () => SkillAdmissionContext,
): Promise<SessionCapabilityCatalog> {
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
	const loader = await buildResourceLoader(cwd, settingsManager, getAdmission);
	const tools: CapabilityCatalogEntry[] = BUILTIN_TOOL_IDS.map((id) => ({ id }));
	const extensions: CapabilityCatalogEntry[] = BUNDLED_EXTENSION_PACKAGES.map(({ name }) => ({
		id: name,
	}));
	const bundledResolvedPaths = new Set(
		(bundled ? [] : resolveDevPaths().extensionPaths).map((path) => resolve(path)),
	);
	for (const extension of loader.getExtensions().extensions) {
		for (const [name, tool] of extension.tools) {
			if (tools.some((entry) => entry.id === name)) continue;
			tools.push({ id: name, description: tool.definition.description });
		}
		const resolvedPath = resolve(extension.resolvedPath);
		if (extension.replaceable || bundledResolvedPaths.has(resolvedPath)) continue;
		if (extension.path.includes("inline:") || extension.hidden) continue;
		extensions.push({
			id: isUnderPath(resolvedPath, cwd) ? relative(resolve(cwd), resolvedPath) : extension.path,
		});
	}
	const skills: CapabilityCatalogEntry[] = loader.getSkills().skills.map((skill) => ({
		id: skill.name,
		description: skill.description,
	}));
	return { tools, skills, extensions };
}

function admissionCacheKey(cwd: string, ctx: SkillAdmissionContext): string {
	return JSON.stringify([
		cwd,
		ctx.trusted,
		[...ctx.acknowledged].sort(),
		[...ctx.disabled].sort(),
		[...ctx.disabledGroups].sort(),
		Object.entries(ctx.overrides).sort(([a], [b]) => a.localeCompare(b)),
	]);
}

const SKILL_LIST_TTL_MS = 5_000;
const skillListCache = new Map<string, { at: number; value: SlashCommandInfo[] }>();

export async function listSkillCommands(
	cwd: string,
	admission: SkillAdmissionContext,
): Promise<SlashCommandInfo[]> {
	const cacheKey = admissionCacheKey(cwd, admission);
	const cached = skillListCache.get(cacheKey);
	if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) return cached.value;
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		...resolveSkillInputs(cwd, () => admission),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const value = toSkillCommands(loader.getSkills().skills);
	skillListCache.set(cacheKey, { at: Date.now(), value });
	return value;
}

export async function listProjectAliasSkillNames(cwd: string): Promise<string[]> {
	const projectPaths = discoverCompatibilitySkillSources(cwd)
		.filter((source) => source.scope === "project")
		.map((source) => source.path);
	if (projectPaths.length === 0) return [];
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		additionalSkillPaths: projectPaths,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader
		.getSkills()
		.skills.filter((skill) => projectPaths.some((path) => isUnderPath(skill.filePath, path)))
		.map((skill) => skill.name);
}

export async function listSkillCatalog(
	cwd: string,
	admission: SkillAdmissionContext,
): Promise<SkillCatalogEntry[]> {
	const discovered = discoverCompatibilitySkillSources(cwd);
	const personal = discovered.filter((s) => s.scope === "user");
	const project = discovered.filter((s) => s.scope === "project");
	const bundledSkillPaths = bundled ? [bundled.skillsDir] : resolveDevPaths().skillPaths;
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
		additionalSkillPaths: [
			...bundledSkillPaths,
			...personal.map((s) => s.path),
			...project.map((s) => s.path),
		],
		skillsOverride: (current) => ({
			...current,
			skills: current.skills.map((skill) => relabelAliasProvenance(skill, discovered)),
		}),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader.getSkills().skills.map((skill) => {
		const source = discovered.find((candidate) => isUnderPath(skill.filePath, candidate.path));
		const gated = source?.scope === "project";
		const { group, isPlugin } = skillGroup(skill.filePath, discovered, bundledSkillPaths);
		return {
			name: skill.name,
			description: skill.description,
			sourceInfo: skill.sourceInfo,
			gated,
			group,
			...(source?.plugin ? { plugin: source.plugin } : {}),
			decision: decideSkill(
				{ name: skill.name, isProjectAlias: gated, group, isPlugin },
				admission,
			),
		};
	});
}
