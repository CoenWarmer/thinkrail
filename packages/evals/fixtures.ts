import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./gitRun";
import type { Fixture, FixtureConfig, FixtureUserTurn, FixtureWorkspace } from "./schemas";

export type SessionSeed = {
	userTurns: FixtureUserTurn[];
	model?: string;
	thinkingLevel?: string;
};

export function extractSessionSeed(sessionJsonl: string): SessionSeed {
	const userTurns: FixtureUserTurn[] = [];
	let model: string | undefined;
	let thinkingLevel: string | undefined;
	for (const line of sessionJsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "model_change") {
			model = `${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}`;
		} else if (entry.type === "thinking_level_change") {
			thinkingLevel = String(entry.thinkingLevel ?? "");
		} else if (entry.type === "message") {
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role !== "user") continue;
			const text = userText(message.content);
			if (text) userTurns.push({ text });
		}
	}
	return {
		userTurns,
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function userText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: { type?: string }) => block.type === "text")
		.map((block: { text?: string }) => block.text ?? "")
		.join("")
		.trim();
}

export type PromoteFixtureInput = {
	id: string;
	source: { sessionId: string; cwd: string };
	workspace: FixtureWorkspace;
	patchPath?: string;
	userTurns: FixtureUserTurn[];
	persona?: string;
	config: FixtureConfig;
	transcriptPath?: string;
};

export function fixtureDir(root: string, id: string): string {
	return join(resolve(root), id);
}

export function promoteFixture(root: string, input: PromoteFixtureInput): Fixture {
	if (input.userTurns.length === 0)
		throw new Error(`fixture ${input.id}: no user turns — nothing to replay`);
	const dir = fixtureDir(root, input.id);
	if (existsSync(join(dir, "fixture.json")))
		throw new Error(`fixture ${input.id} already exists at ${dir}`);
	mkdirSync(dir, { recursive: true });

	let workspace = input.workspace;
	if (input.patchPath) {
		copyFileSync(input.patchPath, join(dir, "start.patch"));
		workspace = { ...workspace, patchFile: "start.patch" };
	}
	let reference: Fixture["reference"];
	if (input.transcriptPath) {
		copyFileSync(input.transcriptPath, join(dir, "reference.jsonl"));
		reference = { transcriptFile: "reference.jsonl" };
	}

	const fixture: Fixture = {
		version: 1,
		id: input.id,
		createdAt: new Date().toISOString(),
		source: input.source,
		workspace,
		user: {
			turns: input.userTurns,
			...(input.persona ? { persona: input.persona } : {}),
		},
		config: input.config,
		...(reference ? { reference } : {}),
	};
	writeFileSync(join(dir, "fixture.json"), `${JSON.stringify(fixture, null, "\t")}\n`);
	return fixture;
}

export function readFixture(root: string, id: string): Fixture {
	const file = join(fixtureDir(root, id), "fixture.json");
	return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

export function replayFixtureWorkspace(
	root: string,
	fixture: Fixture,
	targetDir: string,
): { baseRef: string } {
	const sourceRepo = fixture.source.cwd;
	if (!existsSync(sourceRepo))
		throw new Error(
			`fixture ${fixture.id}: source repo ${sourceRepo} no longer exists — cannot replay`,
		);
	git(".", ["clone", "--quiet", sourceRepo, targetDir]);
	git(targetDir, ["remote", "remove", "origin"]);
	git(targetDir, ["config", "user.email", "evals@thinkrail.local"]);
	git(targetDir, ["config", "user.name", "thinkrail-evals"]);
	git(targetDir, ["config", "commit.gpgsign", "false"]);
	git(targetDir, ["checkout", "--quiet", "--detach", fixture.workspace.head]);
	if (fixture.workspace.patchFile) {
		git(targetDir, ["apply", join(fixtureDir(root, fixture.id), fixture.workspace.patchFile)]);
	}
	git(targetDir, ["add", "-A"]);
	git(targetDir, ["commit", "--quiet", "--allow-empty", "-m", "trial baseline"]);
	return { baseRef: git(targetDir, ["rev-parse", "HEAD"]).trim() };
}
