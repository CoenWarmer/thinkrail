import type { MetricsFileAnnotation } from "@thinkrail/contracts";

export type MetricsHeat = "cool" | "warm" | "hot";

/** Heat is relative to the file's own hottest location (p95 × calls), per the task design. */
export function heatOf(annotation: MetricsFileAnnotation, fileMaxScore: number): MetricsHeat {
	if (fileMaxScore <= 0) return "cool";
	const score = annotation.p95Ms * annotation.callCount;
	if (score >= fileMaxScore * (2 / 3)) return "hot";
	if (score >= fileMaxScore / 3) return "warm";
	return "cool";
}

export function formatCount(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function metricsHintText(annotation: MetricsFileAnnotation): string {
	const parts = [
		`${formatCount(annotation.callCount)} calls`,
		`p95 ${Math.round(annotation.p95Ms)} ms`,
	];
	if (annotation.errorCount > 0) parts.push(`${formatCount(annotation.errorCount)} err`);
	if (!annotation.windowed) parts.push("lifetime");
	return `  · ${parts.join(" · ")}`;
}

export interface MetricsLineDecoration {
	line: number;
	hint: string;
	heat: MetricsHeat;
}

/** One decoration per annotated line that exists in the buffer; later duplicates on a line lose. */
export function buildMetricsLineDecorations(
	annotations: readonly MetricsFileAnnotation[],
	lineCount: number,
): MetricsLineDecoration[] {
	const fileMaxScore = annotations.reduce((max, a) => Math.max(max, a.p95Ms * a.callCount), 0);
	const seen = new Set<number>();
	const out: MetricsLineDecoration[] = [];
	for (const annotation of annotations) {
		if (annotation.line < 1 || annotation.line > lineCount) continue;
		if (seen.has(annotation.line)) continue;
		seen.add(annotation.line);
		out.push({
			line: annotation.line,
			hint: metricsHintText(annotation),
			heat: heatOf(annotation, fileMaxScore),
		});
	}
	return out;
}
