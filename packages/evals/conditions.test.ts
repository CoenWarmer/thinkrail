import { expect, test } from "bun:test";
import { resolveCondition } from "./conditions";
import type { FixtureConfig } from "./schemas";

const config: FixtureConfig = {
	model: "anthropic/claude-sonnet-4-5",
	thinkingLevel: "medium",
	specsAvailable: true,
	skills: ["brainstorming"],
};

test("a bare condition resolves to the fixture's recorded config (the baseline)", () => {
	expect(resolveCondition(config, { id: "baseline" })).toEqual({ id: "baseline", ...config });
});

test("an unset knob inherits the baseline; a set knob overrides it", () => {
	const resolved = resolveCondition(config, {
		id: "cheap-no-specs",
		model: "x/y",
		specsAvailable: false,
	});
	expect(resolved).toEqual({
		id: "cheap-no-specs",
		model: "x/y",
		thinkingLevel: "medium",
		specsAvailable: false,
		skills: ["brainstorming"],
	});
});

test("capability knobs (tools, extensions, promptVariant) override and inherit like the rest", () => {
	const base: FixtureConfig = {
		...config,
		tools: ["read", "bash"],
		extensions: ["pi-spec-graph"],
		promptVariant: "be terse",
	};
	expect(resolveCondition(base, { id: "inherit" })).toEqual({ id: "inherit", ...base });
	const resolved = resolveCondition(base, {
		id: "override",
		tools: ["read"],
		extensions: [],
		promptVariant: "be verbose",
	});
	expect(resolved.tools).toEqual(["read"]);
	expect(resolved.extensions).toEqual([]);
	expect(resolved.promptVariant).toBe("be verbose");
	expect(resolved.model).toBe(base.model);
});

test("knobs absent in both baseline and condition stay absent", () => {
	const sparse: FixtureConfig = { specsAvailable: false };
	const resolved = resolveCondition(sparse, { id: "c" });
	expect(resolved).toEqual({ id: "c", specsAvailable: false });
	expect("model" in resolved).toBe(false);
});

test("records survive a JSON round-trip unchanged", () => {
	const resolved = resolveCondition(config, { id: "rt" });
	expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
});
