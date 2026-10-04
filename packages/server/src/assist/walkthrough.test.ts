import { afterEach, expect, test } from "bun:test";
import {
	buildWalkthroughPrompt,
	setWalkthroughRunner,
	suggestWalkthrough,
	toWalkthroughDrafts,
} from "./walkthrough";

afterEach(() => setWalkthroughRunner(null));

const HUNKS = [
	{ path: "src/a.ts", text: "+added line" },
	{ path: "src/b.ts", text: "-removed line" },
];

test("toWalkthroughDrafts parses a plain JSON array", () => {
	const drafts = toWalkthroughDrafts(
		'[{"hunk":1,"title":"Second","body":"b"},{"hunk":0,"title":"First","body":"a"}]',
		2,
	);
	expect(drafts).toEqual([
		{ hunk: 1, title: "Second", body: "b" },
		{ hunk: 0, title: "First", body: "a" },
	]);
});

test("toWalkthroughDrafts tolerates a code fence", () => {
	const drafts = toWalkthroughDrafts('```json\n[{"hunk":0,"title":"T","body":""}]\n```', 1);
	expect(drafts).toEqual([{ hunk: 0, title: "T", body: "" }]);
});

test("toWalkthroughDrafts drops out-of-range, duplicate, and titleless entries", () => {
	const drafts = toWalkthroughDrafts(
		JSON.stringify([
			{ hunk: 5, title: "oob", body: "" },
			{ hunk: 0, title: "keep", body: "x" },
			{ hunk: 0, title: "dupe", body: "" },
			{ hunk: 1, title: "", body: "no title" },
			{ hunk: 0.5, title: "frac", body: "" },
			"junk",
		]),
		2,
	);
	expect(drafts).toEqual([{ hunk: 0, title: "keep", body: "x" }]);
});

test("toWalkthroughDrafts clamps long strings and collapses whitespace", () => {
	const drafts = toWalkthroughDrafts(
		JSON.stringify([{ hunk: 0, title: `a\n\t${"b".repeat(300)}`, body: "c".repeat(900) }]),
		1,
	);
	expect(drafts?.[0]?.title.length).toBe(120);
	expect(drafts?.[0]?.title.startsWith("a b")).toBe(true);
	expect(drafts?.[0]?.body.length).toBe(700);
});

test("toWalkthroughDrafts salvages complete entries from a truncated array", () => {
	const truncated =
		'[{"hunk":0,"title":"First","body":"a"},{"hunk":1,"title":"Second","body":"b"},{"hunk":2,"title":"Third","body":"cut off mid sent';
	expect(toWalkthroughDrafts(truncated, 3)).toEqual([
		{ hunk: 0, title: "First", body: "a" },
		{ hunk: 1, title: "Second", body: "b" },
	]);
});

test("toWalkthroughDrafts salvages a truncated array inside a code fence tail", () => {
	const truncated = '```json\n[{"hunk":0,"title":"Only","body":"x"},{"hunk":1,"ti';
	expect(toWalkthroughDrafts(truncated, 2)).toEqual([{ hunk: 0, title: "Only", body: "x" }]);
});

test("toWalkthroughDrafts returns null for garbage and empty arrays", () => {
	expect(toWalkthroughDrafts("not json", 1)).toBeNull();
	expect(toWalkthroughDrafts("[]", 1)).toBeNull();
	expect(toWalkthroughDrafts('{"hunk":0}', 1)).toBeNull();
});

test("suggestWalkthrough feeds the inventory and context to the runner", async () => {
	let seen: { system?: string; prompt: string } | null = null;
	setWalkthroughRunner(async (req) => {
		seen = { ...(req.system !== undefined ? { system: req.system } : {}), prompt: req.prompt };
		return { text: '[{"hunk":0,"title":"T","body":"B"}]', model: { provider: "p", id: "m" } };
	});
	const drafts = await suggestWalkthrough(HUNKS, "- fix the login bug");
	expect(drafts).toEqual([{ hunk: 0, title: "T", body: "B" }]);
	const prompt = (seen as unknown as { prompt: string }).prompt;
	expect(prompt).toContain("fix the login bug");
	expect(prompt).toContain("hunk 0 · src/a.ts");
	expect(prompt).toContain("hunk 1 · src/b.ts");
});

test("suggestWalkthrough degrades to null on a throwing runner or empty inventory", async () => {
	setWalkthroughRunner(async () => {
		throw new Error("boom");
	});
	expect(await suggestWalkthrough(HUNKS)).toBeNull();
	expect(await suggestWalkthrough([])).toBeNull();
});

test("buildWalkthroughPrompt omits the context section when absent", () => {
	expect(buildWalkthroughPrompt(HUNKS)).not.toContain("Session context");
	expect(buildWalkthroughPrompt(HUNKS, "  ")).not.toContain("Session context");
	expect(buildWalkthroughPrompt(HUNKS, "ctx")).toContain("Session context");
});
