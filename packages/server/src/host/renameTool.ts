import {
	getSessionWorkspaceId,
	type RenameSessionParams,
	renameSession,
	setRenameSessionHandler,
} from "../agent";
import { getConfig } from "../settings";
import { getWorkspace, renameAgentWorkspace } from "../workspaces";

const ONCE_NOTE =
	"Renaming again is currently off in the user's settings: named targets keep their names; an unnamed target can still be named.";
const CONTINUOUS_NOTE =
	"Renaming again is currently on in the user's settings: rename again only when the session's focus materially changes.";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function renameChat(
	sessionId: string,
	workspaceId: string,
	title: string,
	once: boolean,
): Promise<string> {
	try {
		const cwd = getWorkspace(workspaceId).worktreePath;
		const result = await renameSession(sessionId, workspaceId, cwd, title, "agent", { once });
		if (result === "locked") return "Chat: skipped — the user named it manually.";
		if (result === "named") return "Chat: skipped — this chat is already named.";
		return result === "unchanged"
			? "Chat: already has this title."
			: `Chat: renamed to "${title}".`;
	} catch (err) {
		return `Chat: skipped — ${errorText(err)}.`;
	}
}

function renameWorkspaceFor(workspaceId: string, name: string, once: boolean): string {
	try {
		const ws = getWorkspace(workspaceId);
		if (ws.kind === "default") return "Workspace: skipped — the Default workspace keeps its name.";
		if (ws.kind === "external")
			return "Workspace: skipped — an existing worktree is not renamed by ThinkRail.";
		if (ws.renamed) return "Workspace: skipped — the user named it manually.";
		const { workspace } = renameAgentWorkspace(workspaceId, name, { once });
		return `Workspace: renamed to "${workspace.name}" (its branch is renamed in the background if the branch can be verified as unpushed; otherwise it keeps its current name).`;
	} catch (err) {
		return `Workspace: skipped — ${errorText(err)}.`;
	}
}

export async function applyAgentRename(
	sessionId: string,
	workspaceId: string,
	{ chatTitle, workspaceName }: RenameSessionParams,
): Promise<string> {
	const once = getConfig().agentRenameContinuous !== true;
	const lines: string[] = [];
	if (chatTitle !== undefined)
		lines.push(await renameChat(sessionId, workspaceId, chatTitle, once));
	if (workspaceName !== undefined) lines.push(renameWorkspaceFor(workspaceId, workspaceName, once));
	lines.push(once ? ONCE_NOTE : CONTINUOUS_NOTE);
	return lines.join("\n");
}

export function installRenameSessionSeam(): void {
	setRenameSessionHandler((sessionId, params) => {
		const workspaceId = getSessionWorkspaceId(sessionId);
		if (!workspaceId) throw new Error("This chat is not attached to a workspace.");
		return applyAgentRename(sessionId, workspaceId, params);
	});
}
