import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createRenameSessionTool,
	RENAME_SESSION_TOOL_NAME,
	renameSessionExtension,
	setRenameSessionHandler,
} from "./renameTool";

const ctx = { sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;

test("renameSessionExtension always registers the tool", () => {
	const registered: string[] = [];
	renameSessionExtension({
		registerTool: (t: { name: string }) => registered.push(t.name),
	} as unknown as ExtensionAPI);
	expect(registered).toEqual([RENAME_SESSION_TOOL_NAME]);
});

test("tool guidance asks for both names on the first turn and retitles only when focus changes", () => {
	const tool = createRenameSessionTool();
	const guidance = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
	expect(guidance).toContain("On the first turn");
	expect(guidance).toContain("both chatTitle and workspaceName");
	expect(guidance).toContain("focus materially changes");
	expect(guidance).toContain("tool restrictions take precedence");
});

test("the tool delegates to the host handler with the calling session and requires a target", async () => {
	const calls: unknown[] = [];
	setRenameSessionHandler(async (sessionId, params) => {
		calls.push({ sessionId, params });
		return "Chat: renamed.";
	});
	const tool = createRenameSessionTool();
	const result = await tool.execute("c1", { chatTitle: "Fix login" }, undefined, undefined, ctx);
	expect(result.content).toEqual([{ type: "text", text: "Chat: renamed." }]);
	expect(calls).toEqual([{ sessionId: "s1", params: { chatTitle: "Fix login" } }]);
	await expect(tool.execute("c2", {}, undefined, undefined, ctx)).rejects.toThrow(
		"Pass chatTitle, workspaceName, or both.",
	);
});
