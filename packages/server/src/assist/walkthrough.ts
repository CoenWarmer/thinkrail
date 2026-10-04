import { completeOnce } from "../agent";
import type { OneShotRunner } from "./assist";

let runOneShot: OneShotRunner = completeOnce;

export function setWalkthroughRunner(fn: OneShotRunner | null): void {
	runOneShot = fn ?? completeOnce;
}

const WALKTHROUGH_SYSTEM =
	"You guide a reviewer through a code change hunk by hunk. You are given a numbered inventory of " +
	"diff hunks (and, when available, context about the chat session that produced them). Decide the " +
	"most logical READING order — start with the change's core idea (contracts, data models, the " +
	"central behavior change), then supporting code, then tests and mechanical fallout. Respond with " +
	'ONLY a JSON array; each element is {"hunk": <number from the inventory>, "title": <short ' +
	'headline for what this hunk does, max 8 words>, "body": <1-3 sentences explaining the hunk\'s ' +
	"role in the overall change, plain prose>}. Cover every hunk exactly once. No markdown fence, no " +
	"commentary.";

const WALKTHROUGH_TIMEOUT_MS = 90_000;
const WALKTHROUGH_MAX_TOKENS = 16_000;
const TITLE_MAX = 120;
const BODY_MAX = 700;

export interface WalkthroughHunkInput {
	path: string;
	text: string;
}

export interface WalkthroughStepDraft {
	hunk: number;
	title: string;
	body: string;
}

/**
 * Order and explain a hunk inventory for a guided walkthrough — best-effort, time-boxed. Returns
 * drafts referencing hunks by inventory index (each at most once, invalid entries dropped), or
 * `null` when no model is available, the call times out, or the output is unusable. The caller
 * appends any hunks the model skipped.
 */
export async function suggestWalkthrough(
	hunks: WalkthroughHunkInput[],
	context?: string,
): Promise<WalkthroughStepDraft[] | null> {
	if (hunks.length === 0) return null;
	try {
		const { text } = await runOneShot({
			system: WALKTHROUGH_SYSTEM,
			prompt: buildWalkthroughPrompt(hunks, context),
			tier: "default",
			maxTokens: WALKTHROUGH_MAX_TOKENS,
			signal: AbortSignal.timeout(WALKTHROUGH_TIMEOUT_MS),
		});
		return toWalkthroughDrafts(text, hunks.length);
	} catch {
		return null;
	}
}

export function buildWalkthroughPrompt(hunks: WalkthroughHunkInput[], context?: string): string {
	const parts: string[] = [];
	const trimmed = context?.trim();
	if (trimmed) parts.push(`Session context (what the operator asked for):\n${trimmed}`);
	parts.push(
		`Hunk inventory (${hunks.length} hunks):\n${hunks
			.map((hunk, index) => `--- hunk ${index} · ${hunk.path} ---\n${hunk.text}`)
			.join("\n")}`,
	);
	return parts.join("\n\n");
}

/** Pure output guard: parse the model's JSON (tolerating a code fence and a truncated tail — a
 * length-capped response salvages every complete entry), keep entries whose `hunk` is a valid
 * unused inventory index and whose strings are non-empty after clamping. `null` when nothing
 * usable remains. */
export function toWalkthroughDrafts(raw: string, hunkCount: number): WalkthroughStepDraft[] | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	const parsed = parseArrayLenient((fenced?.[1] ?? raw).trim());
	if (!Array.isArray(parsed)) return null;
	const seen = new Set<number>();
	const drafts: WalkthroughStepDraft[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const { hunk, title, body } = entry as { hunk?: unknown; title?: unknown; body?: unknown };
		if (typeof hunk !== "number" || !Number.isInteger(hunk) || hunk < 0 || hunk >= hunkCount)
			continue;
		if (seen.has(hunk)) continue;
		const cleanTitle = clip(typeof title === "string" ? title : "", TITLE_MAX);
		if (!cleanTitle) continue;
		seen.add(hunk);
		drafts.push({
			hunk,
			title: cleanTitle,
			body: clip(typeof body === "string" ? body : "", BODY_MAX),
		});
	}
	return drafts.length > 0 ? drafts : null;
}

function parseArrayLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Truncated output: retry from the tail, closing the array after each complete-looking entry.
		const start = text.indexOf("[");
		if (start === -1) return null;
		for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
			try {
				return JSON.parse(`${text.slice(start, end + 1)}]`);
			} catch {
				// keep walking back
			}
		}
		return null;
	}
}

function clip(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
