import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const RENAME_SESSION_TOOL_NAME = "rename_session";

export const RenameSessionSchema = Type.Object({
	chatTitle: Type.Optional(
		Type.String({ description: "New title for this chat (3–6 words, at most 80 characters)." }),
	),
	workspaceName: Type.Optional(
		Type.String({
			description:
				"New name for this chat's workspace (≤5 words); its git branch is renamed to match while unpushed.",
		}),
	),
});

export type RenameSessionParams = Static<typeof RenameSessionSchema>;

const DESCRIPTION = `Rename this chat, its workspace (and the workspace's git branch), or both, so the names say what this session is actually for. Pass chatTitle, workspaceName, or both. The result reports each target as renamed or skipped; a target the user named manually is never renamed again.`;

const PROMPT_SNIPPET =
	"rename_session: name this chat and its workspace after what the session is for; keep them relevant.";

const PROMPT_GUIDELINES = [
	"In the first turn of every session, call rename_session with both chatTitle and workspaceName before you write your reply — even when the request is a one-line question or asks for a short answer — so the user always remembers why this session was started. This does not count as editing files or using tools for the user's task.",
	"Later, call rename_session again only when the session's focus materially changes, so the names stay relevant to what is really happening.",
	"Names are short and outcome-focused (e.g. 'Fix login redirect'), never the raw prompt or tool/process wording. Rename silently — do not mention it to the user.",
	"If rename_session reports a target skipped because the user named it manually, accept it and do not retry.",
];

export type RenameSessionHandler = (
	sessionId: string,
	params: RenameSessionParams,
) => Promise<string>;

let handler: RenameSessionHandler = () => {
	throw new Error("Renaming is not available on this host.");
};

export function setRenameSessionHandler(fn: RenameSessionHandler): void {
	handler = fn;
}

export function createRenameSessionTool(): ToolDefinition<typeof RenameSessionSchema> {
	return {
		name: RENAME_SESSION_TOOL_NAME,
		label: "Rename",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: RenameSessionSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = params as RenameSessionParams;
			if (target.chatTitle === undefined && target.workspaceName === undefined) {
				throw new Error("Pass chatTitle, workspaceName, or both.");
			}
			const text = await handler(ctx.sessionManager.getSessionId(), target);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function renameSessionExtension(pi: ExtensionAPI): void {
	pi.registerTool(createRenameSessionTool());
}
