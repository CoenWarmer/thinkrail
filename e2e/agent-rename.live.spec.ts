import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Workspace } from "@thinkrail/contracts";
import { openWorkspaceChat, waitForAgentSettled } from "./fixtures/app";
import { gitText } from "./fixtures/git";
import { E2E_DATA_DIR, E2E_FIXTURE_REPO } from "./fixtures/paths";

function persistedWorkspaces(): Workspace[] {
	return JSON.parse(readFileSync(join(E2E_DATA_DIR, "workspaces.json"), "utf8")) as Workspace[];
}

test("the agent names the chat, workspace, and branch through rename_session without locking them", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(150_000);
	await openWorkspaceChat(page);

	const activeRow = page.locator('[data-testid="workspace-item"][data-active="true"]');
	const name = activeRow.getByTestId("workspace-name");
	const initialName = (await name.textContent()) ?? "";
	expect(initialName).toMatch(/^workspace-\d+$/);
	const before = persistedWorkspaces().find((w) => w.name === initialName);
	if (!before) throw new Error(`no persisted workspace named ${initialName}`);

	await page
		.getByTestId("chat-input")
		.fill(
			"Use rename_session to set chatTitle to 'Plan login form' and workspaceName to 'Login form plan'. Then give one short sentence on how to add a login form to this project. Do not edit files.",
		);
	await page.getByTestId("chat-send").click();
	await waitForAgentSettled(page);

	await expect(name).toHaveText("Login form plan", { timeout: 20_000 });
	await expect
		.poll(() => persistedWorkspaces().find((w) => w.id === before.id)?.branch, { timeout: 20_000 })
		.toBe("login-form-plan");
	const renamed = persistedWorkspaces().find((w) => w.id === before.id);
	expect(renamed?.renamed).toBeUndefined();
	expect(renamed?.worktreePath).toBe(before.worktreePath);
	expect(renamed?.branch).toBe("login-form-plan");
	const branches = gitText(
		E2E_FIXTURE_REPO,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
	);
	expect(branches.split("\n")).toContain(renamed?.branch);

	const chatTab = page.locator('[data-testid="editor-tab"][data-kind="chat"]');
	await expect(chatTab).toContainText("Plan login form", { timeout: 20_000 });
});
