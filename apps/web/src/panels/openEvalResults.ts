import { useAppStore } from "../store";

export function openEvalResults(workspaceId: string, experimentId: string): void {
	useAppStore.getState().openDoc({
		kind: "eval-results",
		id: `${workspaceId}:eval:${experimentId}`,
		workspaceId,
		name: `Results · ${experimentId}`,
		experimentId,
	});
}
