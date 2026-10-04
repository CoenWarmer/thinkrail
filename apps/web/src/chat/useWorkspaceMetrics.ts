import type { MetricsSummary } from "@thinkrail/contracts";
import { useEffect } from "react";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";

/** Hydrate-then-stream: read `metrics.summary` on mount and again on every `metrics.updated` tick
 * for this workspace. The host reports facts only; staleness verdicts stay in the indicator. */
export function useWorkspaceMetrics(workspaceId: string): MetricsSummary | null {
	const entry = useAppStore((s) => s.metricsByWorkspace[workspaceId]);
	const tick = entry?.tick ?? 0;
	useEffect(() => {
		let cancelled = false;
		getTransport()
			.request("metrics.summary", { workspaceId })
			.then((summary) => {
				if (!cancelled) useAppStore.getState().setMetricsSummary(workspaceId, summary);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, tick]);
	return entry?.summary ?? null;
}
