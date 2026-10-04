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
		if (useAppStore.getState().removedWorkspaceIds[id]) return;
		const mine = ++generation.current;
		const live = () =>
			generation.current === mine && !useAppStore.getState().removedWorkspaceIds[id];
		const transport = getTransport();
		Promise.all([
			transport.request("eval.fixtures", { workspaceId: id }),
			transport.request("eval.experiments", { workspaceId: id }),
		])
			.then(([fixtures, experiments]) => {
				if (!live()) return;
				const workspace = selectWorkspaceById(useAppStore.getState(), id);
				if (!workspace) return;
				useAppStore
					.getState()
					.setProjectEvals(
						workspace.projectId,
						{ fixtures: fixtures.fixtures, experiments: experiments.experiments },
						experiments.run,
					);
				setFailedFor(null);
			})
			.catch(() => {
				if (live()) setFailedFor(id);
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
