import { EVALS_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { selectWorkspaceById, useAppStore } from "../store";
import { getTransport } from "../transport";

// no fs-tick refetch by design — see panels/SPEC.md § EvalsPanel
export function useProjectEvals(workspaceId: string | null): {
	failed: boolean;
	reload: () => void;
} {
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const supported = useAppStore(
		(s) => s.protocolVersion !== null && s.protocolVersion >= EVALS_PROTOCOL_VERSION,
	);
	const connectionGeneration = useAppStore((s) => s.connectionGeneration);
	const generation = useRef(0);

	const runRead = useCallback((id: string) => {
		const mine = ++generation.current;
		fetchProjectEvals(id)
			.then((ok) => {
				if (generation.current === mine && ok) setFailedFor(null);
			})
			.catch(() => {
				if (generation.current === mine) setFailedFor(id);
			});
	}, []);

	useEffect(() => {
		if (!workspaceId || !supported) return;
		runRead(workspaceId);
		return () => {
			generation.current += 1;
		};
	}, [workspaceId, supported, connectionGeneration, runRead]);

	return {
		failed: failedFor !== null && failedFor === workspaceId,
		reload: () => {
			if (workspaceId && supported) runRead(workspaceId);
		},
	};
}

const readGenerations = new Map<string, number>();

/**
 * The one eval read+fold: tombstone- and generation-guarded (a newer read for the same workspace
 * invalidates an older in-flight one, so a slow hydration can never overwrite a fresher snapshot).
 * Resolves false when skipped, rejects on failure.
 */
export async function fetchProjectEvals(workspaceId: string): Promise<boolean> {
	if (useAppStore.getState().removedWorkspaceIds[workspaceId]) return false;
	const mine = (readGenerations.get(workspaceId) ?? 0) + 1;
	readGenerations.set(workspaceId, mine);
	const transport = getTransport();
	const [fixtures, experiments] = await Promise.all([
		transport.request("eval.fixtures", { workspaceId }),
		transport.request("eval.experiments", { workspaceId }),
	]);
	if (readGenerations.get(workspaceId) !== mine) return false;
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) return false;
	const workspace = selectWorkspaceById(state, workspaceId);
	if (!workspace) return false;
	state.setProjectEvals(
		workspace.projectId,
		{ fixtures: fixtures.fixtures, experiments: experiments.experiments },
		experiments.run,
	);
	return true;
}
