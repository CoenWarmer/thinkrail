import type { MetricsSummary } from "@thinkrail/contracts";
import { METRICS_INGEST_PREFIX } from "./ingest";
import { ingestStatus, topLocations } from "./store";

const TOP_LOCATIONS = 10;

/** Host-relative — the client composes the full URL against its own transport endpoint. */
export function metricsIngestPath(workspaceId: string): string {
	return `${METRICS_INGEST_PREFIX}${encodeURIComponent(workspaceId)}/v1/traces`;
}

export function metricsSummary(workspaceId: string, now = Date.now()): MetricsSummary {
	return {
		...ingestStatus(workspaceId),
		ingestPath: metricsIngestPath(workspaceId),
		topLocations: topLocations(workspaceId, TOP_LOCATIONS, now),
	};
}
