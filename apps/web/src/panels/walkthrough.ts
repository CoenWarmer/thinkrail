import {
	matchesWorktreePath,
	selectDiffScope,
	toast,
	useAppStore,
	walkthroughFingerprint,
} from "../store";
import { errorText, getTransport } from "../transport";
import { scopeKey } from "./changesModel";
import { openDiffInTab } from "./openTabs";

/** Generate and install a walkthrough for the workspace's current diff scope (optionally restricted
 * to a turn's changed files, with its chat session as context), then jump to step 1. The store's
 * generation fence makes a scope switch during the request a silent no-op. */
export async function startWalkthrough(
	workspaceId: string,
	options?: { sessionId?: string; paths?: string[] },
): Promise<void> {
	const state = useAppStore.getState();
	if (state.walkthroughGenerating[workspaceId]) return;
	const scope = selectDiffScope(state, workspaceId);
	const generation = state.beginWalkthrough(workspaceId);
	try {
		const transport = getTransport();
		// Pre-generate fingerprint + post-install reconcile: staleness model owned by panels/SPEC.md.
		const status = await transport.request("git.status", { workspaceId, scope });
		const requested = options?.paths;
		const paths = requested
			? status.changes
					.filter((change) => requested.some((want) => matchesWorktreePath(want, change.path)))
					.map((change) => change.path)
			: null;
		if (paths !== null && paths.length === 0) {
			useAppStore.getState().failWalkthrough(workspaceId, generation);
			toast.info("That turn's files have no changes left in this scope.");
			return;
		}
		const { steps } = await transport.request("walkthrough.generate", {
			workspaceId,
			scope,
			...(options?.sessionId ? { sessionId: options.sessionId } : {}),
			...(paths ? { paths } : {}),
		});
		useAppStore.getState().installWalkthrough(workspaceId, generation, {
			scopeKey: scopeKey(scope),
			fingerprint: walkthroughFingerprint(status.changes, paths),
			paths,
			steps,
		});
		if (useAppStore.getState().walkthroughGenerationByWorkspace[workspaceId] !== generation) return;
		try {
			const fresh = await transport.request("git.status", { workspaceId, scope });
			useAppStore.getState().reconcileWalkthrough(workspaceId, scopeKey(scope), fresh.changes);
		} catch {
			// Best-effort verification; the panel's next status load reconciles anyway.
		}
		if (useAppStore.getState().walkthroughByWorkspace[workspaceId]) {
			goToWalkthroughStep(workspaceId, 0);
		} else {
			toast.info("The changes moved while the walkthrough was generated — try again.");
		}
	} catch (error) {
		useAppStore.getState().failWalkthrough(workspaceId, generation);
		toast.error(errorText(error), "Couldn't generate the walkthrough");
	}
}

/** Activate a step: clamp-set the index and open its file's diff (preview) in the current scope. */
export function goToWalkthroughStep(workspaceId: string, index: number): void {
	const state = useAppStore.getState();
	const walkthrough = state.walkthroughByWorkspace[workspaceId];
	const step = walkthrough?.steps[index];
	if (!walkthrough || !step) return;
	state.setWalkthroughIndex(workspaceId, index);
	void openDiffInTab(workspaceId, selectDiffScope(state, workspaceId), step.path, "preview");
}
