import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const RENAME_SESSION_TOOL_NAME = "rename_session";

export const RenameSessionSchema = Type.Object({
	chatTitle: Type.Optional(
		Type.String({
			description: "Short, descriptive title for this chat (2–5 words, at most 80 characters).",
		}),
	),
	workspaceName: Type.Optional(
		Type.String({
			description:
				"Short, descriptive name for this chat's workspace (2–5 words; for a pull-request review, '#<number> <PR title>'). Its git branch is renamed to match while unpushed.",
		}),
	),
});

export type RenameSessionParams = Static<typeof RenameSessionSchema>;

const DESCRIPTION = `Name this chat, its workspace (and the workspace's git branch), or both, so the names say what this session is for. Pass chatTitle, workspaceName, or both. The result reports each target as renamed or skipped and notes whether the user's setting currently allows renaming named targets again; a target the user named manually is never renamed.`;

const PROMPT_SNIPPET =
	"rename_session: give this chat and its workspace a short, descriptive name once you understand the task.";

const PROMPT_GUIDELINES = [
	"On the first turn, once you know the session's purpose, call rename_session once with both chatTitle and workspaceName before replying — including for short answers — unless the user explicitly forbids tools or limits you to specific tools. Their tool restrictions take precedence over naming.",
	"Names are short and descriptive: 2–5 words naming the outcome (e.g. 'Fix login redirect'), never the raw prompt or tool/process wording. Rename silently — do not mention it to the user.",
	"When the session reviews a pull request, set workspaceName to the PR number and title, e.g. '#565 Agent-driven naming' — shorten a long title.",
	"If a target was not named yet (you passed only one of chatTitle and workspaceName), you may name it later once its purpose is clear.",
	"Call rename_session again for an already-named target only when the session's focus materially changes; the host applies the user's current naming setting and skips the rename when renaming again is off.",
	"If rename_session reports a target skipped, accept it and do not retry until the session's focus materially changes again.",
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
