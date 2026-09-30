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

test("tool guidance names once, short and descriptive, with PR reviews named by number and title", () => {
	const tool = createRenameSessionTool();
	const guidance = [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
	expect(guidance).toContain("call rename_session once with both chatTitle and workspaceName");
	expect(guidance).toContain("short and descriptive");
	expect(guidance).toContain("PR number and title, e.g. '#565 Agent-driven naming'");
	expect(guidance).toContain("you may name it later once its purpose is clear");
	expect(guidance).toContain("host applies the user's current naming setting");
	expect(guidance).not.toContain("last result said");
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
