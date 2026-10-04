import type { MetricsFileAnnotation } from "@thinkrail/contracts";
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";

/** Hydrate-then-stream: read `metrics.forFile` on mount and again on every `metrics.updated` tick
 * for the workspace (the push is already host-throttled). Line anchors are version-true to the
 * RUNNING build, not edit-true — see submodule-server-metrics. */
export function useFileMetrics(workspaceId: string, path: string): MetricsFileAnnotation[] {
	const tick = useAppStore((s) => s.metricsByWorkspace[workspaceId]?.tick ?? 0);
	const visible = useAppStore((s) => s.metricsLayerVisible);
	const [state, setState] = useState<{ key: string; annotations: MetricsFileAnnotation[] } | null>(
		null,
	);
	const key = `${workspaceId}:${path}`;
	useEffect(() => {
		if (!visible) return;
		let cancelled = false;
		getTransport()
			.request("metrics.forFile", { workspaceId, path })
			.then(({ annotations }) => {
				if (!cancelled) setState({ key: `${workspaceId}:${path}`, annotations });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, path, tick, visible]);
	return visible && state?.key === key ? state.annotations : EMPTY;
}

const EMPTY: MetricsFileAnnotation[] = [];
