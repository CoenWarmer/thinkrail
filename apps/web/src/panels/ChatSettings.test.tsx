import { expect, test } from "bun:test";
import {
	AGENT_RENAME_SETTING_PROTOCOL_VERSION,
	SUBAGENT_SETTINGS_PROTOCOL_VERSION,
	type SubagentOverride,
	type Workspace,
} from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRenameSettings, ChatSettings, SubagentSettings } from "./ChatSettings";

test("Chat settings renders one two-handle streaming movement control", () => {
	const markup = renderToStaticMarkup(<ChatSettings />);
	expect(markup).toContain("Streaming response movement");
	expect(markup).toContain(
		"Choose when the chat moves while an answer grows and where its newest edge lands.",
	);
	expect(markup).toContain('data-testid="streaming-response-movement"');
	expect(markup).toContain('data-testid="streaming-movement-settle" aria-label="Settle position"');
	expect(markup).toContain('aria-valuetext="75% from the top"');
	expect(markup).toContain(
		'data-testid="streaming-movement-trigger" aria-label="Trigger position"',
	);
	expect(markup).toContain('aria-valuetext="100% from the top"');
	expect(markup.match(/type="range"/g)).toHaveLength(2);
});

function workspace(subagentsOverride?: SubagentOverride): Workspace {
	return {
		id: "ws1",
		projectId: "p1",
		name: "Checkout flow",
		branch: "checkout-flow",
		worktreePath: "/tmp/checkout-flow",
		baseBranch: "main",
		...(subagentsOverride ? { subagentsOverride } : {}),
	};
}

function renderSettings({
	protocolVersion = SUBAGENT_SETTINGS_PROTOCOL_VERSION,
	globalEnabled = true,
	activeWorkspace,
}: {
	protocolVersion?: number;
	globalEnabled?: boolean;
	activeWorkspace?: Workspace;
} = {}): string {
	return renderToStaticMarkup(
		<SubagentSettings
			protocolVersion={protocolVersion}
			globalEnabled={globalEnabled}
			workspace={activeWorkspace ?? null}
			onGlobalChange={() => {}}
			onWorkspaceChange={() => {}}
		/>,
	);
}

test("subagent controls stay hidden against hosts older than their protocol", () => {
	const markup = renderSettings({
		protocolVersion: SUBAGENT_SETTINGS_PROTOCOL_VERSION - 1,
		activeWorkspace: workspace("off"),
	});

	expect(markup).not.toContain('data-testid="settings-subagents"');
});

test("subagent settings show the global default without inventing a local control", () => {
	const markup = renderSettings({ globalEnabled: true });

	expect(markup).toContain('data-testid="settings-subagents"');
	expect(markup).toContain('data-testid="subagents-global-toggle"');
	expect(markup).toContain('aria-checked="true"');
	expect(markup).not.toContain('data-testid="subagents-workspace-options"');
});

test("an active workspace shows its named three-state override", () => {
	const markup = renderSettings({
		globalEnabled: true,
		activeWorkspace: workspace("off"),
	});

	expect(markup).toContain("This workspace — Checkout flow");
	expect(markup).toContain('data-testid="subagents-workspace-options"');
	expect(markup).toContain('data-testid="subagents-workspace-inherit"');
	expect(markup).toContain('data-testid="subagents-workspace-on"');
	expect(markup).toContain('data-testid="subagents-workspace-off"');
	expect(markup).toContain('data-testid="subagents-workspace-off" data-active="true"');
});

function renderRename(protocolVersion: number | null, continuous: boolean): string {
	return renderToStaticMarkup(
		<AgentRenameSettings
			protocolVersion={protocolVersion}
			continuous={continuous}
			onChange={() => {}}
		/>,
	);
}

test("the naming switch stays hidden against hosts older than its protocol", () => {
	expect(renderRename(AGENT_RENAME_SETTING_PROTOCOL_VERSION - 1, false)).toBe("");
	expect(renderRename(null, false)).toBe("");
});

test("the naming switch defaults to naming once and reports continuous mode when on", () => {
	const off = renderRename(AGENT_RENAME_SETTING_PROTOCOL_VERSION, false);
	expect(off).toContain("Chat &amp; workspace naming");
	expect(off).toContain('data-testid="agent-rename-continuous-toggle"');
	expect(off).toContain("the agent names each chat and workspace once");
	expect(off).toContain('aria-checked="false"');
	const on = renderRename(AGENT_RENAME_SETTING_PROTOCOL_VERSION, true);
	expect(on).toContain("renames a chat or workspace again when its focus changes");
	expect(on).toContain('aria-checked="true"');
});
