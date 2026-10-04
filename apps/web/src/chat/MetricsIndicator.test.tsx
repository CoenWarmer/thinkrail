import { expect, test } from "bun:test";
import type { MetricsSummary } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricsIndicator, metricsStatus } from "./MetricsIndicator";

function summary(overrides: Partial<MetricsSummary> = {}): MetricsSummary {
	return {
		lastReceivedAt: 1_000_000,
		services: ["checkout"],
		totalSpans: 42,
		locationCount: 3,
		ingestPath: "/ingest/otlp/ws-1/v1/traces",
		topLocations: [],
		...overrides,
	};
}

test("status: never before any ingest, receiving within the window, stale after", () => {
	expect(metricsStatus(null, 1_000_000)).toBe("never");
	expect(metricsStatus(summary({ lastReceivedAt: null }), 1_000_000)).toBe("never");
	expect(metricsStatus(summary(), 1_000_000 + 15_000)).toBe("receiving");
	expect(metricsStatus(summary(), 1_000_000 + 120_000)).toBe("stale");
});

test("the indicator stays visible before any ingest (the setup discovery surface)", () => {
	const html = renderToStaticMarkup(
		<MetricsIndicator summary={null} now={1_000_000} ingestUrl={null} />,
	);
	expect(html).toContain('data-testid="metrics-indicator"');
	expect(html).toContain('data-status="never"');
});

test("the trigger reports receiving and stale from lastReceivedAt", () => {
	const receiving = renderToStaticMarkup(
		<MetricsIndicator
			summary={summary()}
			now={1_000_000 + 15_000}
			ingestUrl="http://host/ingest/otlp/ws-1/v1/traces"
		/>,
	);
	expect(receiving).toContain('data-status="receiving"');
	const stale = renderToStaticMarkup(
		<MetricsIndicator
			summary={summary()}
			now={1_000_000 + 120_000}
			ingestUrl="http://host/ingest/otlp/ws-1/v1/traces"
		/>,
	);
	expect(stale).toContain('data-status="stale"');
});
