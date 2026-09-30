import {
	getSessionWorkspaceId,
	type RenameSessionParams,
	renameSession,
	setRenameSessionHandler,
} from "../agent";
import { getConfig } from "../settings";
import { getWorkspace, renameAgentWorkspace } from "../workspaces";

const ONCE_NOTE = "These names are final: do not call rename_session again in this session.";
const CONTINUOUS_NOTE =
	"Further renames are allowed: call rename_session again only if the session's focus materially changes.";

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

async function renameWorkspaceFor(
	workspaceId: string,
	name: string,
	once: boolean,
): Promise<string> {
	try {
		const ws = getWorkspace(workspaceId);
		if (ws.kind === "default") return "Workspace: skipped — the Default workspace keeps its name.";
		if (ws.kind === "external")
			return "Workspace: skipped — an existing worktree is not renamed by ThinkRail.";
		if (ws.renamed) return "Workspace: skipped — the user named it manually.";
		const next = await renameAgentWorkspace(workspaceId, name, { once });
		const branch =
			next.branch === ws.branch
				? `branch "${ws.branch}" kept`
				: `branch renamed to "${next.branch}"`;
		return `Workspace: renamed to "${next.name}" (${branch}).`;
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
	if (workspaceName !== undefined)
		lines.push(await renameWorkspaceFor(workspaceId, workspaceName, once));
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
