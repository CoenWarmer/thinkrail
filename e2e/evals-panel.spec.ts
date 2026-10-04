import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject } from "./fixtures/app";

test("Evals is an unplaced tool: showable from a side group, with honest empty states", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);

	await expect(page.getByTestId("tab-specs")).toBeVisible();
	await page.getByTestId("side-group-menu").first().click();
	await page.getByTestId("show-tool-evals").click();

	const panel = page.getByTestId("evals-panel");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("No fixtures yet");
	await expect(panel).toContainText("No experiments yet");
	await expect(panel.getByTestId("eval-composer-open")).toBeDisabled();

	// the promote picker lists this workspace's sessions (none yet in a fresh workspace)
	await panel.getByTestId("eval-promote-open").click();
	await expect(page.getByRole("dialog")).toContainText(/No sessions|Loading/);
});
