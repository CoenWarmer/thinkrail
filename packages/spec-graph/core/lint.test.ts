import { expect, test } from "bun:test";
import {
	DEFAULT_SPEC_BUDGETS,
	formatLintFinding,
	LINT_RULES,
	type LintRule,
	lintSpec,
	lintSpecs,
	MODULE_SECTIONS,
	REQUIRED_MODULE_SECTIONS,
	SECTIONED_TYPES,
	type SpecBudgets,
} from "./index.ts";

const FM = "---\nid: x\ntype: submodule-design\ntitle: X\n---\n";

function entry(body: string, type = "submodule-design") {
	return {
		path: "x/SPEC.md",
		content: `---\nid: x\ntype: ${type}\ntitle: X\n---\n${body}`,
		frontmatter: { id: "x", type, title: "X" },
	};
}

function rules(body: string, type?: string, budgets?: SpecBudgets): LintRule[] {
	return lintSpec(entry(body, type), budgets).map((f) => f.rule);
}

const SKELETON = `## Responsibility

What it is for.

## Boundary

- **Public surface:** \`a\`.
`;

test("vocabularies are the approved skeleton", () => {
	expect([...MODULE_SECTIONS]).toEqual([
		"Responsibility",
		"Boundary",
		"Behavior",
		"Invariants",
		"Decisions",
		"History",
	]);
	expect([...REQUIRED_MODULE_SECTIONS]).toEqual(["Responsibility", "Boundary"]);
	expect([...SECTIONED_TYPES]).toEqual(["module-design", "submodule-design"]);
	expect(LINT_RULES).toHaveLength(9);
	expect(DEFAULT_SPEC_BUDGETS).toEqual({
		maxLines: 400,
		maxWords: 4000,
		maxBytes: 50 * 1024,
		maxHeadingGap: 60,
		maxBulletLines: 8,
		maxTableCellChars: 200,
	});
});

test("a skeleton-shaped spec under budget has no findings", () => {
	expect(rules(SKELETON)).toEqual([]);
	expect(
		rules(`${SKELETON}\n## Behavior\n\n### Topic\n\nText.\n\n## Invariants\n\n1. Never.\n`),
	).toEqual([]);
});

test("line numbers count from the top of the file, past the frontmatter", () => {
	const findings = lintSpec(entry(`${SKELETON}\n## Extra\n\nText.\n`));
	expect(findings).toEqual([
		{
			rule: "unknown-section",
			path: "x/SPEC.md",
			line: FM.split("\n").length - 1 + 9,
			message: '"## Extra" is not a skeleton section',
		},
	]);
	expect(formatLintFinding(findings[0] as never)).toBe(
		'x/SPEC.md:14 [unknown-section] "## Extra" is not a skeleton section',
	);
});

test("size rules: lines, words, bytes", () => {
	const budgets: SpecBudgets = { ...DEFAULT_SPEC_BUDGETS, maxLines: 5, maxWords: 8, maxBytes: 120 };
	const findings = lintSpec(entry(`${SKELETON}one two three four five six\n`), budgets);
	const byRule = Object.fromEntries(findings.map((f) => [f.rule, f]));
	expect(byRule.lines?.message).toMatch(/^8 lines \(budget 5\)$/);
	expect(byRule.lines?.line).toBe(1);
	expect(byRule.words?.message).toMatch(/words \(budget 8\)$/);
	expect(byRule.bytes?.message).toMatch(/KB \(budget 0 KB\)$/);
	expect(rules("## Responsibility\n\nx\n\n## Boundary\n", undefined, budgets)).not.toContain(
		"lines",
	);
});

test("heading-gap flags long stretches after a heading, before the first heading, and at the tail", () => {
	const budgets: SpecBudgets = { ...DEFAULT_SPEC_BUDGETS, maxHeadingGap: 3 };
	const filler = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
	const after = lintSpec(entry(`## Responsibility\n${filler(4)}\n\n## Boundary\n\nx\n`), budgets);
	expect(after.filter((f) => f.rule === "heading-gap")).toEqual([
		{
			rule: "heading-gap",
			path: "x/SPEC.md",
			line: 6,
			message: '5 lines after "Responsibility" (budget 3)',
		},
	]);
	const before = lintSpec(
		entry(`${filler(4)}\n## Responsibility\n\nx\n\n## Boundary\n\ny\n`),
		budgets,
	);
	expect(before.find((f) => f.rule === "heading-gap")?.message).toBe(
		"4 lines before the first heading (budget 3)",
	);
	const tail = lintSpec(
		entry(`## Responsibility\n\nx\n\n## Boundary\n${filler(4)}\n\n\n`),
		budgets,
	);
	expect(tail.find((f) => f.rule === "heading-gap")?.message).toBe(
		'4 lines after "Boundary" (budget 3)',
	);
	expect(
		rules(`## Responsibility\n${filler(3)}\n## Boundary\n\nx\n`, undefined, budgets),
	).not.toContain("heading-gap");
});

test("bullet-length measures one item's own lines; nested items, blanks, and headings end it", () => {
	const budgets: SpecBudgets = { ...DEFAULT_SPEC_BUDGETS, maxBulletLines: 2 };
	const long = `${SKELETON}- a\n  b\n  c\n`;
	expect(lintSpec(entry(long), budgets).filter((f) => f.rule === "bullet-length")).toEqual([
		{
			rule: "bullet-length",
			path: "x/SPEC.md",
			line: 13,
			message: "list item spans 3 lines (budget 2)",
		},
	]);
	expect(rules(`${SKELETON}- a\n  b\n  - c\n    d\n`, undefined, budgets)).not.toContain(
		"bullet-length",
	);
	expect(rules(`${SKELETON}1. a\n   b\n\n   c\n`, undefined, budgets)).not.toContain(
		"bullet-length",
	);
	expect(rules(`${SKELETON}- a\n  b\n### H\n  c\n`, undefined, budgets)).not.toContain(
		"bullet-length",
	);
});

test("table-cell flags the widest cell on a row", () => {
	const budgets: SpecBudgets = { ...DEFAULT_SPEC_BUDGETS, maxTableCellChars: 5 };
	const body = `${SKELETON}\n| a | bcdefgh |\n| --- | --- |\n| ok | ok |\n`;
	const found = lintSpec(entry(body), budgets).filter((f) => f.rule === "table-cell");
	expect(found).toEqual([
		{
			rule: "table-cell",
			path: "x/SPEC.md",
			line: 14,
			message: "table cell of 7 chars (budget 5)",
		},
	]);
});

test("fenced code is ignored by structure rules", () => {
	const budgets: SpecBudgets = {
		...DEFAULT_SPEC_BUDGETS,
		maxBulletLines: 1,
		maxTableCellChars: 2,
		maxHeadingGap: 4,
	};
	const body = `${SKELETON}\n\`\`\`md\n## Not a section\n- a\n  b\n| a | bcd |\n\`\`\`\n`;
	const found = rules(body, undefined, budgets);
	expect(found).not.toContain("unknown-section");
	expect(found).not.toContain("bullet-length");
	expect(found).not.toContain("table-cell");
	const gap = lintSpec(entry(`${SKELETON}\`\`\`\n## A\n## B\n## C\n## D\n## E\n\`\`\`\n`), budgets);
	expect(gap.filter((f) => f.rule === "heading-gap")).toHaveLength(1);
});

test("section rules apply only to module and submodule specs", () => {
	expect(rules("## Responsibility\n\nx\n")).toEqual(["missing-section"]);
	expect(lintSpec(entry("## Boundary\n\nx\n"))[0]?.message).toBe('no "## Responsibility" section');
	expect(rules(`${SKELETON}\n## Behavior\n\n## History\n\n- x\n`)).toEqual(["empty-section"]);
	expect(rules(`${SKELETON}\n## Behavior\n\n### Topic\n\nText.\n`)).toEqual([]);
	expect(rules("## Whatever\n\nx\n", "architecture-design")).toEqual([]);
	expect(rules("## Whatever\n\nx\n", "task-spec")).toEqual([]);
	expect(rules("## Whatever\n\nx\n", "module-design")).toEqual([
		"missing-section",
		"missing-section",
		"unknown-section",
	]);
});

test("lintSpecs aggregates across entries, sorted by path then line", () => {
	const report = lintSpecs([
		entry("## Boundary\n\nx\n"),
		{ ...entry(`${SKELETON}\n## Zed\n\nx\n`), path: "a/SPEC.md" },
	]);
	expect(report.checked).toBe(2);
	expect(report.findings.map((f) => `${f.path}:${f.rule}`)).toEqual([
		"a/SPEC.md:unknown-section",
		"x/SPEC.md:missing-section",
	]);
});
