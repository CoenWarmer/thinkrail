import { expect, test } from "bun:test";
import type { MetricsFileAnnotation } from "@thinkrail/contracts";
import { buildMetricsLineDecorations, formatCount, metricsHintText } from "./metricsDecorations";

function annotation(overrides: Partial<MetricsFileAnnotation> = {}): MetricsFileAnnotation {
	return {
		line: 1,
		functionName: "fn",
		callCount: 100,
		errorCount: 0,
		p50Ms: 5,
		p95Ms: 20,
		maxMs: 90,
		windowed: true,
		...overrides,
	};
}

test("hint text carries calls, p95, and errors/lifetime only when present", () => {
	expect(metricsHintText(annotation({ callCount: 1200, p95Ms: 48.4 }))).toBe(
		"  · 1.2k calls · p95 48 ms",
	);
	expect(metricsHintText(annotation({ errorCount: 3, windowed: false }))).toBe(
		"  · 100 calls · p95 20 ms · 3 err · lifetime",
	);
});

test("formatCount compacts large counts", () => {
	expect(formatCount(999)).toBe("999");
	expect(formatCount(1_234)).toBe("1.2k");
	expect(formatCount(45_000)).toBe("45k");
	expect(formatCount(2_500_000)).toBe("2.5M");
});

test("heat is relative to the file's own max, out-of-buffer and duplicate lines drop", () => {
	const decorations = buildMetricsLineDecorations(
		[
			annotation({ line: 1, callCount: 100, p95Ms: 100 }), // score 10000 → hot
			annotation({ line: 2, callCount: 100, p95Ms: 50 }), // score 5000 → warm
			annotation({ line: 3, callCount: 10, p95Ms: 10 }), // score 100 → cool
			annotation({ line: 1, callCount: 1, p95Ms: 1 }), // duplicate line → dropped
			annotation({ line: 99, callCount: 1, p95Ms: 1 }), // beyond buffer → dropped
		],
		10,
	);
	expect(decorations.map((d) => [d.line, d.heat])).toEqual([
		[1, "hot"],
		[2, "warm"],
		[3, "cool"],
	]);
});

test("a file with no traffic yields no heat", () => {
	const decorations = buildMetricsLineDecorations([annotation({ callCount: 0, p95Ms: 0 })], 10);
	expect(decorations[0]?.heat).toBe("cool");
});
