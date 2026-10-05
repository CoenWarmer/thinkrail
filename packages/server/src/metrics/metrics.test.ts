import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMetricsIngest, resetMetricsPublisher, setMetricsPublisher } from "./ingest";
import { parseOtlpTraces } from "./otlp";
import {
	fileAnnotations,
	ingestStatus,
	MAX_LOCATIONS_PER_WORKSPACE,
	normalizeSpanPath,
	recordSpans,
	resetMetricsStore,
	type SpanObservation,
	topLocations,
} from "./store";

let dataDir: string;
let worktree: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-metrics-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	worktree = join(dataDir, "repo");
	mkdirSync(worktree, { recursive: true });
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([
			{
				id: "w1",
				projectId: "p1",
				name: "w1",
				branch: "main",
				worktreePath: worktree,
				baseBranch: "main",
				createdAt: 1,
			},
		]),
	);
});

afterEach(() => {
	resetMetricsStore();
	resetMetricsPublisher();
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

function span(overrides: Partial<SpanObservation> = {}): SpanObservation {
	return {
		rawPath: join(worktree, "src", "slow.ts"),
		functionName: "slowFn",
		line: 10,
		durationMs: 50,
		error: false,
		...overrides,
	};
}

test("normalizeSpanPath maps worktree-absolute and relative paths, rejects escapes", () => {
	expect(normalizeSpanPath(join(worktree, "src", "a.ts"), worktree)).toBe("src/a.ts");
	expect(normalizeSpanPath("src/a.ts", worktree)).toBe("src/a.ts");
	expect(normalizeSpanPath("/elsewhere/a.ts", worktree)).toBeNull();
	expect(normalizeSpanPath("../escape.ts", worktree)).toBeNull();
});

test("recordSpans aggregates counts, errors, and quantiles per location", () => {
	const t = 1_000_000;
	const spans = [
		...Array.from({ length: 95 }, () => span({ durationMs: 10 })),
		...Array.from({ length: 5 }, () => span({ durationMs: 2000, error: true })),
	];
	const changed = recordSpans("w1", worktree, ["api"], spans, t);
	expect([...changed]).toEqual(["src/slow.ts"]);
	const rows = fileAnnotations("w1", "src/slow.ts", t);
	expect(rows).toHaveLength(1);
	const row = rows[0];
	if (!row) throw new Error("missing annotation row");
	expect(row).toMatchObject({ line: 10, callCount: 100, errorCount: 5, maxMs: 2000 });
	expect(row.p50Ms).toBeGreaterThan(5);
	expect(row.p50Ms).toBeLessThan(20);
	expect(row.p95Ms).toBeGreaterThan(5);
	expect(row.p95Ms).toBeLessThanOrEqual(row.maxMs);
	const status = ingestStatus("w1");
	expect(status.services).toEqual(["api"]);
	expect(status.totalSpans).toBe(100);
	expect(status.lastReceivedAt).toBe(t);
});

test("window stats age out and reads fall back to lifetime totals", () => {
	const t = 1_000_000;
	recordSpans("w1", worktree, [], [span({ durationMs: 100 })], t);
	expect(fileAnnotations("w1", "src/slow.ts", t + 60_000)[0]).toMatchObject({ windowed: true });
	expect(fileAnnotations("w1", "src/slow.ts", t + 20 * 60_000)[0]).toMatchObject({
		windowed: false,
		callCount: 1,
	});
});

test("topLocations ranks by hotness and out-of-worktree spans stay queryable without a path", () => {
	const t = 1_000_000;
	recordSpans(
		"w1",
		worktree,
		[],
		[
			span({ durationMs: 1, functionName: "cheap", line: 1 }),
			span({ durationMs: 5000, functionName: "expensive", line: 2 }),
			span({ rawPath: "/outside/lib.ts", functionName: "external", durationMs: 9000 }),
		],
		t,
	);
	const top = topLocations("w1", 10, t);
	expect(top[0]).toMatchObject({ functionName: "external", path: null });
	expect(top[1]).toMatchObject({ functionName: "expensive" });
	expect(fileAnnotations("w1", "src/slow.ts", t)).toHaveLength(2);
});

test("location cardinality is capped with LRU eviction", () => {
	const t = 1_000_000;
	for (let i = 0; i < MAX_LOCATIONS_PER_WORKSPACE + 5; i++) {
		recordSpans("w1", worktree, [], [span({ functionName: `fn${i}`, line: i + 1 })], t + i);
	}
	expect(ingestStatus("w1").locationCount).toBe(MAX_LOCATIONS_PER_WORKSPACE);
	const survivors = fileAnnotations("w1", "src/slow.ts", t + 10 ** 9);
	expect(survivors.some((row) => row.functionName === "fn0")).toBe(false);
	expect(survivors.some((row) => row.functionName === "fn2004")).toBe(true);
});

function otlpBody(options: { path?: string; stableNames?: boolean } = {}): unknown {
	const path = options.path ?? join(worktree, "src", "slow.ts");
	const attributes = options.stableNames
		? [
				{ key: "code.file.path", value: { stringValue: path } },
				{ key: "code.function.name", value: { stringValue: "slowFn" } },
				{ key: "code.line.number", value: { intValue: "10" } },
			]
		: [
				{ key: "code.filepath", value: { stringValue: path } },
				{ key: "code.function", value: { stringValue: "slowFn" } },
				{ key: "code.lineno", value: { intValue: 10 } },
			];
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
				scopeSpans: [
					{
						spans: [
							{
								name: "slowFn",
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "51000000000",
								status: { code: 2 },
								attributes,
							},
							{ name: "unattributed", startTimeUnixNano: "0", endTimeUnixNano: "1000000" },
						],
					},
				],
			},
		],
	};
}

test("parseOtlpTraces accepts both attribute generations and skips unattributed spans", () => {
	for (const stableNames of [true, false]) {
		const parsed = parseOtlpTraces(otlpBody({ stableNames }));
		expect(parsed).not.toBeNull();
		expect(parsed?.serviceNames).toEqual(["api"]);
		expect(parsed?.totalSpans).toBe(2);
		expect(parsed?.spans).toHaveLength(1);
		expect(parsed?.spans[0]).toMatchObject({
			functionName: "slowFn",
			line: 10,
			durationMs: 50_000,
			error: true,
		});
	}
	expect(parseOtlpTraces({ notOtlp: true })).toBeNull();
});

function ingest(body: BodyInit, path = "/ingest/otlp/w1/v1/traces", init: RequestInit = {}) {
	return handleMetricsIngest(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			...init,
		}),
		path,
	);
}

test("ingest handler validates method, workspace, content type, and body", async () => {
	const payload = JSON.stringify(otlpBody());
	expect((await ingest(payload, "/ingest/otlp/w1/v1/metrics")).status).toBe(404);
	expect((await ingest(payload, "/ingest/otlp/nope/v1/traces")).status).toBe(404);
	expect((await ingest(payload, "/ingest/otlp/w1/v1/traces", { method: "GET" })).status).toBe(405);
	const protobuf = await handleMetricsIngest(
		new Request("http://localhost/ingest/otlp/w1/v1/traces", {
			method: "POST",
			headers: { "Content-Type": "application/x-protobuf" },
			body: payload,
		}),
		"/ingest/otlp/w1/v1/traces",
	);
	expect(protobuf.status).toBe(415);
	expect(((await protobuf.json()) as { error: string }).error).toContain("http/json");
	const oversized = await ingest(JSON.stringify(otlpBody()), "/ingest/otlp/w1/v1/traces", {
		headers: { "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) },
	});
	expect(oversized.status).toBe(413);
	expect((await ingest("not json")).status).toBe(400);
	expect((await ingest(JSON.stringify({ notOtlp: true }))).status).toBe(400);
});

test("ingest handler records spans and publishes a throttled update", async () => {
	const published: { workspaceId: string; paths: string[] }[] = [];
	setMetricsPublisher((payload) => published.push(payload), 10);
	const first = await ingest(JSON.stringify(otlpBody()));
	expect(first.status).toBe(200);
	const second = await ingest(JSON.stringify(otlpBody({ path: join(worktree, "src", "b.ts") })));
	expect(second.status).toBe(200);
	expect(published).toHaveLength(0);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(published).toHaveLength(1);
	expect(published[0]).toEqual({ workspaceId: "w1", paths: ["src/b.ts", "src/slow.ts"] });
	expect(fileAnnotations("w1", "src/slow.ts")).toHaveLength(1);
	expect(ingestStatus("w1").services).toEqual(["api"]);
});
