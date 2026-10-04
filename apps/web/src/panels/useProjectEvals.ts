import { EVALS_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useState } from "react";
import { selectWorkspaceById, useAppStore } from "../store";
import { getTransport } from "../transport";
import { useWorkspaceRead } from "./useWorkspaceRead";

export function useProjectEvals(workspaceId: string | null): {
	failed: boolean;
	reload: () => void;
} {
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const supported = useAppStore(
		(s) => s.protocolVersion !== null && s.protocolVersion >= EVALS_PROTOCOL_VERSION,
	);

	const { reload } = useWorkspaceRead(
		supported ? workspaceId : null,
		async (id) => {
			const transport = getTransport();
			const [fixtures, experiments] = await Promise.all([
				transport.request("eval.fixtures", { workspaceId: id }),
				transport.request("eval.experiments", { workspaceId: id }),
			]);
			return { fixtures, experiments };
		},
		{
			onResult: (result, id) => {
				const workspace = selectWorkspaceById(useAppStore.getState(), id);
				if (!workspace) return;
				useAppStore.getState().setProjectEvals(
					workspace.projectId,
					{
						fixtures: result.fixtures.fixtures,
						experiments: result.experiments.experiments,
					},
					result.experiments.run,
				);
				setFailedFor(null);
			},
			onFailure: (id) => setFailedFor(id),
		},
	);

	return { failed: failedFor !== null && failedFor === workspaceId, reload };
}
