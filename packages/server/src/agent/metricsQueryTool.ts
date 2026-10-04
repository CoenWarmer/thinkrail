import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MetricsFileAnnotation, MetricsLocation, MetricsSummary } from "@thinkrail/contracts";
import { type Static, Type } from "typebox";

export const METRICS_QUERY_TOOL_NAME = "metrics_query";

export const MetricsQuerySchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Workspace-relative file path to narrow to: returns that file's per-line aggregates instead of the workspace's hottest locations.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Max locations to return (default 10, max 50).",
			minimum: 1,
			maximum: 50,
		}),
	),
});

export type MetricsQueryParams = Static<typeof MetricsQuerySchema>;

const DESCRIPTION = `Query the runtime metrics ThinkRail has received from the user's running application (OpenTelemetry trace spans pushed to this host, aggregated per code location). Returns call counts, error counts, and duration quantiles (p50/p95/max) keyed by file, function, and line — either the workspace's hottest locations, or one file's per-line aggregates when path is given. Metrics describe the RUNNING build: after local edits, line numbers may be shifted until the app restarts. Use on demand when runtime behavior (hot paths, latency, error rates) is relevant; there is no data unless the user's app is exporting traces to this host.`;

export interface MetricsQueryOutcome {
	summary: MetricsSummary;
	topLocations: MetricsLocation[];
	file?: { path: string; annotations: MetricsFileAnnotation[] };
}

let handler: (sessionId: string, params: MetricsQueryParams) => MetricsQueryOutcome = () => {
	throw new Error("Runtime metrics are not available on this host.");
};

export function setMetricsQueryHandler(
	fn: (sessionId: string, params: MetricsQueryParams) => MetricsQueryOutcome,
): void {
	handler = fn;
}

export function createMetricsQueryTool(): ToolDefinition<typeof MetricsQuerySchema> {
	return {
		name: METRICS_QUERY_TOOL_NAME,
		label: "Query Runtime Metrics",
		description: DESCRIPTION,
		parameters: MetricsQuerySchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as MetricsQueryParams;
			const outcome = handler(ctx.sessionManager.getSessionId(), p);
			return {
				content: [{ type: "text", text: renderOutcome(outcome, p) }],
				details: {
					lastReceivedAt: outcome.summary.lastReceivedAt,
					locationCount: outcome.summary.locationCount,
					...(p.path ? { path: p.path } : {}),
				},
			};
		},
	};
}

function renderOutcome(outcome: MetricsQueryOutcome, params: MetricsQueryParams): string {
	const { summary } = outcome;
	if (summary.lastReceivedAt === null) {
		return [
			"No runtime metrics have been received for this workspace.",
			`The user's running application must push OTLP/HTTP JSON traces to this host: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json and point OTEL_EXPORTER_OTLP_ENDPOINT at the ThinkRail host with path ${summary.ingestPath.replace(/\/v1\/traces$/, "")} (the SDK appends /v1/traces).`,
			"Only OTLP/HTTP JSON is accepted — the default http/protobuf is rejected.",
		].join("\n");
	}
	const header = [
		`Ingest: last batch ${new Date(summary.lastReceivedAt).toISOString()}, ${summary.totalSpans} spans total, ${summary.locationCount} code locations, services: ${summary.services.join(", ") || "(unnamed)"}.`,
		"Line numbers are from the RUNNING build and may be shifted relative to edited files.",
	];
	if (outcome.file) {
		if (outcome.file.annotations.length === 0) {
			return [
				...header,
				`No metrics for ${outcome.file.path} — either the running build has not executed code attributed to this file, or its spans lack code.filepath attribution.`,
			].join("\n");
		}
		const rows = outcome.file.annotations.map(
			(a) =>
				`  L${a.line} ${a.functionName} — ${a.callCount} calls, ${a.errorCount} errors, p50 ${a.p50Ms}ms, p95 ${a.p95Ms}ms, max ${a.maxMs}ms${a.windowed ? "" : " (lifetime — recent window empty)"}`,
		);
		return [...header, `Metrics for ${outcome.file.path}:`, ...rows].join("\n");
	}
	if (outcome.topLocations.length === 0) {
		return [
			...header,
			"Spans are arriving but none carry code.filepath/code.lineno attribution, so no per-location aggregates exist.",
		].join("\n");
	}
	const rows = outcome.topLocations.map(
		(l) =>
			`  ${l.path ?? l.rawPath}:${l.line} ${l.functionName} — ${l.callCount} calls, ${l.errorCount} errors, p50 ${l.p50Ms}ms, p95 ${l.p95Ms}ms, max ${l.maxMs}ms${l.windowed ? "" : " (lifetime)"}${l.path === null ? " (outside worktree)" : ""}`,
	);
	const count = params.limit ?? 10;
	return [
		...header,
		`Hottest ${Math.min(count, rows.length)} locations by call count:`,
		...rows,
	].join("\n");
}

export function metricsQueryToolExtension(pi: ExtensionAPI): void {
	pi.registerTool(createMetricsQueryTool());
}
