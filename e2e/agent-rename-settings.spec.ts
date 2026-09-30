import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";
import { E2E_DATA_DIR } from "./fixtures/paths";

function persistedContinuous(): unknown {
	const config = JSON.parse(readFileSync(join(E2E_DATA_DIR, "config.json"), "utf8")) as Record<
		string,
		unknown
	>;
	return config.agentRenameContinuous;
}

async function openNamingSettings(page: Page) {
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-chat").click();
	const block = page.getByTestId("settings-agent-rename");
	await expect(block).toBeVisible();
	return block.getByTestId("agent-rename-continuous-toggle");
}

test("continuous agent renaming is off by default and toggles through the host", async ({
	page,
}) => {
	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	const toggle = await openNamingSettings(page);
	try {
		await expect(toggle).toHaveAttribute("data-active", "false");
		await expect(page.getByTestId("settings-agent-rename")).toContainText(
			"the agent names each chat and workspace once",
		);

		await toggle.click();
		await expect(toggle).toHaveAttribute("data-active", "true");
		await expect.poll(persistedContinuous).toBe(true);

		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		const reloaded = await openNamingSettings(page);
		await expect(reloaded).toHaveAttribute("data-active", "true");
		await reloaded.click();
		await expect(reloaded).toHaveAttribute("data-active", "false");
		await expect.poll(persistedContinuous).toBe(false);
	} finally {
		if (persistedContinuous() === true && !page.isClosed()) {
			const current = page.getByTestId("agent-rename-continuous-toggle");
			if (await current.isVisible()) await current.click();
		}
	}
});
