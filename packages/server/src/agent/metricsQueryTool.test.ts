import { describe, expect, it } from "bun:test";
import type { MetricsSummary } from "@thinkrail/contracts";
import {
	createMetricsQueryTool,
	METRICS_QUERY_TOOL_NAME,
	setMetricsQueryHandler,
} from "./metricsQueryTool";

const ctx = { sessionManager: { getSessionId: () => "sess-1" } } as never;

function emptySummary(): MetricsSummary {
	return {
		lastReceivedAt: null,
		services: [],
		totalSpans: 0,
		locationCount: 0,
		ingestPath: "/ingest/otlp/ws-1/v1/traces",
		topLocations: [],
	};
}

async function run(params: Record<string, unknown>): Promise<string> {
	const tool = createMetricsQueryTool();
	const result = await tool.execute("tc-1", params as never, undefined as never, undefined, ctx);
	const block = result.content[0];
	if (block?.type !== "text") throw new Error("expected text content");
	return block.text;
}

describe("metrics_query tool", () => {
	it("is named metrics_query", () => {
		expect(createMetricsQueryTool().name).toBe(METRICS_QUERY_TOOL_NAME);
	});

	it("names the ingest endpoint and http/json requirement when no data has arrived", async () => {
		setMetricsQueryHandler(() => ({
			summary: emptySummary(),
			topLocations: [],
		}));
		const text = await run({});
		expect(text).toContain("No runtime metrics");
		expect(text).toContain("/ingest/otlp/ws-1");
		expect(text).toContain("OTEL_EXPORTER_OTLP_PROTOCOL=http/json");
	});

	it("renders top locations with quantiles", async () => {
		setMetricsQueryHandler(() => ({
			summary: {
				...emptySummary(),
				lastReceivedAt: 1700000000000,
				services: ["checkout"],
				totalSpans: 42,
				locationCount: 1,
			},
			topLocations: [
				{
					path: "src/cart.ts",
					rawPath: "/app/src/cart.ts",
					functionName: "addItem",
					line: 12,
					callCount: 40,
					errorCount: 2,
					p50Ms: 5,
					p95Ms: 20,
					maxMs: 90,
					windowed: true,
				},
			],
		}));
		const text = await run({});
		expect(text).toContain("src/cart.ts:12 addItem");
		expect(text).toContain("40 calls, 2 errors, p50 5ms, p95 20ms, max 90ms");
		expect(text).toContain("checkout");
	});

	it("renders one file's annotations when path is given", async () => {
		setMetricsQueryHandler((_sessionId, params) => ({
			summary: { ...emptySummary(), lastReceivedAt: 1700000000000, totalSpans: 1 },
			topLocations: [],
			file: {
				path: params.path ?? "",
				annotations: [
					{
						line: 3,
						functionName: "handler",
						callCount: 1,
						errorCount: 0,
						p50Ms: 2,
						p95Ms: 2,
						maxMs: 2,
						windowed: false,
					},
				],
			},
		}));
		const text = await run({ path: "src/api.ts" });
		expect(text).toContain("Metrics for src/api.ts:");
		expect(text).toContain("L3 handler");
		expect(text).toContain("lifetime");
	});

	it("explains missing attribution when spans arrive without code locations", async () => {
		setMetricsQueryHandler(() => ({
			summary: { ...emptySummary(), lastReceivedAt: 1700000000000, totalSpans: 9 },
			topLocations: [],
		}));
		const text = await run({});
		expect(text).toContain("code.filepath");
	});
});
