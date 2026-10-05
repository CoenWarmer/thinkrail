import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCapabilities } from "@thinkrail/contracts";
import { assertConditionCapabilities, conditionOverrides, evalCapabilities } from "./evalsRunner";

const capabilities: EvalCapabilities = {
	tools: [{ id: "read" }, { id: "bash" }],
	skills: [{ id: "brainstorming" }],
	extensions: [{ id: "pi-spec-graph" }, { id: "pi-web-access" }],
};

describe("assertConditionCapabilities", () => {
	it("accepts knobs whose names all exist in the catalog", () => {
		expect(() =>
			assertConditionCapabilities(
				{ id: "ok", tools: ["read"], skills: ["brainstorming"], extensions: ["pi-web-access"] },
				capabilities,
			),
		).not.toThrow();
	});

	it("fails loudly on an unknown tool, skill, or extension name", () => {
		expect(() => assertConditionCapabilities({ id: "c", tools: ["raed"] }, capabilities)).toThrow(
			/unknown tools name\(s\): raed/,
		);
		expect(() => assertConditionCapabilities({ id: "c", skills: ["nope"] }, capabilities)).toThrow(
			/unknown skills name\(s\): nope/,
		);
		expect(() =>
			assertConditionCapabilities({ id: "c", extensions: ["pi-specgraph"] }, capabilities),
		).toThrow(/unknown extensions name\(s\): pi-specgraph/);
	});
});

describe("conditionOverrides", () => {
	let root: string;
	let project: string;
	const original: Record<string, string | undefined> = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "thinkrail-eval-overrides-"));
		project = join(root, "project");
		mkdirSync(project, { recursive: true });
		mkdirSync(join(root, "home"), { recursive: true });
		mkdirSync(join(root, "pi-agent"), { recursive: true });
		process.env.HOME = join(root, "home");
		process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
	});

	afterAll(() => {
		for (const [name, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("a knob-free condition maps to no overrides", async () => {
		expect(await conditionOverrides(project, { id: "baseline" })).toBeNull();
		expect(await conditionOverrides(project, { id: "specs-on", specsAvailable: true })).toBeNull();
	});

	it("inverts the extensions allowlist against the trial-workspace catalog", async () => {
		const overrides = await conditionOverrides(project, {
			id: "web-only",
			extensions: ["pi-web-access"],
		});
		expect(overrides?.excludedExtensionIds).toEqual(
			expect.arrayContaining([
				"pi-visualize",
				"pi-spec-graph",
				"pi-thinkrail-workflow",
				"pi-todos",
			]),
		);
		expect(overrides?.excludedExtensionIds).not.toContain("pi-web-access");
	});

	it("specs-off adds pi-spec-graph; tools/skills/promptVariant pass through", async () => {
		const overrides = await conditionOverrides(project, {
			id: "lean",
			specsAvailable: false,
			tools: ["read", "bash"],
			promptVariant: "be terse",
		});
		expect(overrides?.excludedExtensionIds).toEqual(["pi-spec-graph"]);
		expect(overrides?.tools).toEqual(["read", "bash"]);
		expect(overrides?.systemPromptSuffix).toBe("be terse");
		expect(overrides?.skillsAllowlist).toBeUndefined();
	});

	it("re-validates per trial: an unknown skill fails before any session is created", async () => {
		expect(conditionOverrides(project, { id: "typo", skills: ["does-not-exist"] })).rejects.toThrow(
			/unknown skills name\(s\)/,
		);
	});

	it("evalCapabilities lists the bundled extension ids for a bare workspace", async () => {
		const caps = await evalCapabilities(project);
		expect(caps.extensions.map((entry) => entry.id)).toEqual([
			"pi-web-access",
			"pi-visualize",
			"pi-spec-graph",
			"pi-thinkrail-workflow",
			"pi-todos",
		]);
	});
});
