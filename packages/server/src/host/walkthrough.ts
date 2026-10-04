import type { GitDiffScope, WalkthroughStep } from "@thinkrail/contracts";
import { isControlMessage } from "@thinkrail/contracts";
import { structuredPatch } from "diff";
import { getSessionMessages } from "../agent";
import {
	suggestWalkthrough,
	type WalkthroughHunkInput,
	type WalkthroughStepDraft,
} from "../assist";
import { gitDiffFile, gitStatus } from "../git";
import { getWorkspace } from "../workspaces";

const MAX_HUNKS = 80;
const HUNK_TEXT_MAX = 1_600;
const CONTEXT_MESSAGES = 6;
const CONTEXT_MESSAGE_MAX = 600;

export interface WalkthroughParams {
	workspaceId: string;
	scope?: GitDiffScope;
	sessionId?: string;
	paths?: string[];
}

export interface InventoryHunk extends WalkthroughHunkInput {
	anchor: Pick<WalkthroughStep, "path" | "original" | "modified">;
}

export async function generateWalkthrough(
	params: WalkthroughParams,
): Promise<{ steps: WalkthroughStep[] }> {
	const hunks = await buildHunkInventory(params);
	if (hunks.length === 0) throw new Error("No text changes to walk through in this scope.");
	const context = params.sessionId
		? await sessionContext(params.sessionId, params.workspaceId)
		: undefined;
	const drafts = await suggestWalkthrough(hunks, context);
	if (!drafts) throw new Error("Couldn't generate the walkthrough — try again.");
	return { steps: assembleSteps(hunks, drafts) };
}

/** Model-explained steps in the model's order, then every skipped hunk appended in file order with
 * a fallback title — the walkthrough always covers the whole inventory. */
export function assembleSteps(
	hunks: InventoryHunk[],
	drafts: WalkthroughStepDraft[],
): WalkthroughStep[] {
	const steps: WalkthroughStep[] = [];
	const explained = new Set<number>();
	for (const draft of drafts) {
		const hunk = hunks[draft.hunk];
		if (!hunk || explained.has(draft.hunk)) continue;
		explained.add(draft.hunk);
		steps.push({ ...hunk.anchor, title: draft.title, body: draft.body });
	}
	for (const [index, hunk] of hunks.entries()) {
		if (explained.has(index)) continue;
		steps.push({ ...hunk.anchor, title: fallbackTitle(hunk.anchor), body: "" });
	}
	return steps;
}

async function buildHunkInventory(params: WalkthroughParams): Promise<InventoryHunk[]> {
	const status = await gitStatus(params.workspaceId, params.scope);
	const wanted = params.paths ? new Set(params.paths) : null;
	const files = status.changes.filter((change) => !wanted || wanted.has(change.path));
	const hunks: InventoryHunk[] = [];
	const skipped: InventoryHunk[] = [];
	for (const file of files) {
		if (hunks.length >= MAX_HUNKS) break;
		const diff = await gitDiffFile(params.workspaceId, file.path, params.scope);
		const originalText = diff.meta.original.text ? diff.original : null;
		const modifiedText = diff.meta.modified.text ? diff.modified : null;
		if (originalText === null && modifiedText === null) continue;
		const patch = structuredPatch(
			file.path,
			file.path,
			originalText ?? "",
			modifiedText ?? "",
			undefined,
			undefined,
			{ context: 0 },
		);
		for (const hunk of patch.hunks) {
			if (hunks.length >= MAX_HUNKS) break;
			const inventoryHunk: InventoryHunk = {
				path: file.path,
				text: clip(hunk.lines.join("\n"), HUNK_TEXT_MAX),
				anchor: {
					path: file.path,
					original: { start: Math.max(1, hunk.oldStart), count: hunk.oldLines },
					modified: { start: Math.max(1, hunk.newStart), count: hunk.newLines },
				},
			};
			if (isInsignificantHunk(hunk.lines)) {
				if (skipped.length < MAX_HUNKS) skipped.push(inventoryHunk);
				continue;
			}
			hunks.push(inventoryHunk);
		}
	}
	return hunks.length > 0 ? hunks : skipped;
}

const INSIGNIFICANT_LINE = /^(?:import\b|\}?\s*from\s+["']|export\s+(?:type\s+)?[{*]|export\s+\{)/;

/** Import/re-export-only churn (plus blank lines) carries no reviewable idea — it is mechanical
 * fallout of the hunks that do. Walkthroughs skip such hunks entirely. */
export function isInsignificantHunk(lines: string[]): boolean {
	let changed = 0;
	for (const line of lines) {
		if (line.length === 0 || (line[0] !== "+" && line[0] !== "-")) continue;
		const content = line.slice(1).trim();
		if (content.length === 0) continue;
		changed += 1;
		if (!INSIGNIFICANT_LINE.test(content)) return false;
	}
	return changed > 0;
}

async function sessionContext(sessionId: string, workspaceId: string): Promise<string | undefined> {
	try {
		const cwd = getWorkspace(workspaceId).worktreePath;
		const { messages } = await getSessionMessages(sessionId, workspaceId, cwd);
		const asks: string[] = [];
		for (const message of messages) {
			if (!("role" in message) || message.role !== "user") continue;
			const text = textOf(message.content);
			if (!text || isControlMessage(text)) continue;
			asks.push(clip(text, CONTEXT_MESSAGE_MAX));
		}
		const recent = asks.slice(-CONTEXT_MESSAGES);
		return recent.length > 0 ? recent.map((ask) => `- ${ask}`).join("\n") : undefined;
	} catch {
		return undefined;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}

function fallbackTitle(anchor: Pick<WalkthroughStep, "path" | "modified">): string {
	const base = anchor.path.split("/").at(-1) ?? anchor.path;
	return `Changes in ${base} (L${anchor.modified.start})`;
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
