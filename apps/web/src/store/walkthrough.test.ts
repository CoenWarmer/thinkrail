import { beforeEach, expect, test } from "bun:test";
import type { GitFileChange, WalkthroughStep } from "@thinkrail/contracts";
import { useAppStore, walkthroughFingerprint } from "./appStore";

const CHANGES: GitFileChange[] = [
	{ path: "src/a.ts", status: "modified", added: 3, removed: 1 },
	{ path: "src/b.ts", status: "added", added: 10 },
];

function step(path: string, title: string): WalkthroughStep {
	return {
		path,
		original: { start: 1, count: 0 },
		modified: { start: 1, count: 1 },
		title,
		body: "",
	};
}

function install(paths: string[] | null = null) {
	const generation = useAppStore.getState().beginWalkthrough("ws1");
	useAppStore.getState().installWalkthrough("ws1", generation, {
		scopeKey: "branch",
		fingerprint: walkthroughFingerprint(CHANGES, paths),
		paths,
		steps: [step("src/a.ts", "One"), step("src/b.ts", "Two")],
	});
}

beforeEach(() => {
	useAppStore.setState({
		walkthroughByWorkspace: {},
		walkthroughGenerating: {},
		walkthroughGenerationByWorkspace: {},
		walkthroughRequest: null,
		removedWorkspaceIds: {},
		diffScopeByWorkspace: {},
		layoutIntents: [],
	});
});

test("requestWalkthrough records the request and reveals the changes tool", () => {
	useAppStore.getState().requestWalkthrough("ws1", "session-1", ["src/a.ts"]);
	const state = useAppStore.getState();
	expect(state.walkthroughRequest).toEqual({
		workspaceId: "ws1",
		sessionId: "session-1",
		paths: ["src/a.ts"],
	});
	expect(
		state.layoutIntents.some(
			(intent) =>
				intent.kind === "reveal-tool" && intent.workspaceId === "ws1" && intent.tool === "changes",
		),
	).toBe(true);
	useAppStore.getState().clearWalkthroughRequest();
	expect(useAppStore.getState().walkthroughRequest).toBeNull();
});

test("walkthroughFingerprint is order-insensitive and respects the path subset", () => {
	const reversed = [...CHANGES].reverse();
	expect(walkthroughFingerprint(reversed, null)).toBe(walkthroughFingerprint(CHANGES, null));
	expect(walkthroughFingerprint(CHANGES, ["src/a.ts"])).toBe(
		walkthroughFingerprint([CHANGES[0] as GitFileChange], null),
	);
	expect(walkthroughFingerprint(CHANGES, ["src/a.ts"])).not.toBe(
		walkthroughFingerprint(CHANGES, null),
	);
});

test("install clears the generating flag and starts at step 0", () => {
	const generation = useAppStore.getState().beginWalkthrough("ws1");
	expect(useAppStore.getState().walkthroughGenerating.ws1).toBe(true);
	useAppStore.getState().installWalkthrough("ws1", generation, {
		scopeKey: "branch",
		fingerprint: walkthroughFingerprint(CHANGES, null),
		paths: null,
		steps: [step("src/a.ts", "One"), step("src/b.ts", "Two")],
	});
	const state = useAppStore.getState();
	expect(state.walkthroughGenerating.ws1).toBeUndefined();
	expect(state.walkthroughByWorkspace.ws1?.activeIndex).toBe(0);
	expect(state.walkthroughByWorkspace.ws1?.steps).toHaveLength(2);
});

test("a stale generation cannot install and cannot clear a newer flag", () => {
	const stale = useAppStore.getState().beginWalkthrough("ws1");
	useAppStore.getState().setDiffScope("ws1", { kind: "uncommitted" });
	expect(useAppStore.getState().walkthroughGenerating.ws1).toBeUndefined();
	useAppStore.getState().installWalkthrough("ws1", stale, {
		scopeKey: "branch",
		fingerprint: "f",
		paths: null,
		steps: [step("src/a.ts", "Late")],
	});
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeUndefined();
	const fresh = useAppStore.getState().beginWalkthrough("ws1");
	useAppStore.getState().failWalkthrough("ws1", stale);
	expect(useAppStore.getState().walkthroughGenerating.ws1).toBe(true);
	useAppStore.getState().failWalkthrough("ws1", fresh);
	expect(useAppStore.getState().walkthroughGenerating.ws1).toBeUndefined();
});

test("setWalkthroughIndex clamps to the step range", () => {
	install();
	useAppStore.getState().setWalkthroughIndex("ws1", 1);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1?.activeIndex).toBe(1);
	useAppStore.getState().setWalkthroughIndex("ws1", 2);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1?.activeIndex).toBe(1);
	useAppStore.getState().setWalkthroughIndex("ws1", -1);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1?.activeIndex).toBe(1);
});

test("reconcile keeps a matching snapshot and clears a moved diff", () => {
	install();
	useAppStore.getState().reconcileWalkthrough("ws1", "branch", CHANGES);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeDefined();
	useAppStore
		.getState()
		.reconcileWalkthrough("ws1", "branch", [
			{ path: "src/a.ts", status: "modified", added: 4, removed: 1 },
			CHANGES[1] as GitFileChange,
		]);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeUndefined();
});

test("reconcile with a path subset ignores unrelated files", () => {
	install(["src/a.ts"]);
	useAppStore
		.getState()
		.reconcileWalkthrough("ws1", "branch", [
			CHANGES[0] as GitFileChange,
			{ path: "src/other.ts", status: "added", added: 99 },
		]);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeDefined();
	useAppStore
		.getState()
		.reconcileWalkthrough("ws1", "branch", [
			{ path: "src/a.ts", status: "modified", added: 5, removed: 5 },
		]);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeUndefined();
});

test("a scope switch clears the walkthrough", () => {
	install();
	useAppStore.getState().setDiffScope("ws1", { kind: "uncommitted" });
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeUndefined();
});

test("reconcile under a different scope key clears the walkthrough", () => {
	install();
	useAppStore.getState().reconcileWalkthrough("ws1", "uncommitted", CHANGES);
	expect(useAppStore.getState().walkthroughByWorkspace.ws1).toBeUndefined();
});
