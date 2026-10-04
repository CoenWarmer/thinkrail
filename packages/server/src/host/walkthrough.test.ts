import { expect, test } from "bun:test";
import { assembleSteps, type InventoryHunk } from "./walkthrough";

function hunk(path: string, start: number): InventoryHunk {
	return {
		path,
		text: "+x",
		anchor: {
			path,
			original: { start, count: 0 },
			modified: { start, count: 1 },
		},
	};
}

const HUNKS = [hunk("src/a.ts", 1), hunk("src/b.ts", 10), hunk("src/b.ts", 40)];

test("assembleSteps keeps the model's order and anchors each step", () => {
	const steps = assembleSteps(HUNKS, [
		{ hunk: 2, title: "Core", body: "c" },
		{ hunk: 0, title: "Support", body: "s" },
		{ hunk: 1, title: "Tests", body: "t" },
	]);
	expect(steps.map((s) => s.title)).toEqual(["Core", "Support", "Tests"]);
	expect(steps[0]?.path).toBe("src/b.ts");
	expect(steps[0]?.modified).toEqual({ start: 40, count: 1 });
});

test("assembleSteps appends skipped hunks in file order with a fallback title", () => {
	const steps = assembleSteps(HUNKS, [{ hunk: 1, title: "Only", body: "" }]);
	expect(steps.map((s) => s.title)).toEqual([
		"Only",
		"Changes in a.ts (L1)",
		"Changes in b.ts (L40)",
	]);
});

test("assembleSteps ignores duplicate and unknown draft indices", () => {
	const steps = assembleSteps(HUNKS, [
		{ hunk: 0, title: "A", body: "" },
		{ hunk: 0, title: "A again", body: "" },
		{ hunk: 99, title: "ghost", body: "" },
	]);
	expect(steps).toHaveLength(3);
	expect(steps.map((s) => s.title)).toEqual([
		"A",
		"Changes in b.ts (L10)",
		"Changes in b.ts (L40)",
	]);
});
