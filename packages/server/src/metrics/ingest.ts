import type { MetricsUpdatedPayload, Workspace } from "@thinkrail/contracts";
import { logger } from "../log";
import { getWorkspace } from "../workspaces";
import { parseOtlpTraces } from "./otlp";
import { recordSpans } from "./store";

const log = logger("metrics");

export const METRICS_INGEST_PREFIX = "/ingest/otlp/";
const INGEST_PATH = /^\/ingest\/otlp\/([^/]+)\/v1\/traces$/;
const DEFAULT_PUBLISH_THROTTLE_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type MetricsPublisher = (payload: MetricsUpdatedPayload) => void;

let publish: MetricsPublisher | null = null;
let publishThrottleMs = DEFAULT_PUBLISH_THROTTLE_MS;
const pending = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();

export function setMetricsPublisher(
	publisher: MetricsPublisher | null,
	throttleMs = DEFAULT_PUBLISH_THROTTLE_MS,
): void {
	publish = publisher;
	publishThrottleMs = throttleMs;
	for (const entry of pending.values()) clearTimeout(entry.timer);
	pending.clear();
}

function queuePublish(workspaceId: string, paths: Set<string>): void {
	if (!publish) return;
	const entry = pending.get(workspaceId);
	if (entry) {
		for (const path of paths) entry.paths.add(path);
		return;
	}
	const timer = setTimeout(() => {
		const queued = pending.get(workspaceId);
		pending.delete(workspaceId);
		if (queued && publish) publish({ workspaceId, paths: [...queued.paths].sort() });
	}, publishThrottleMs);
	pending.set(workspaceId, { paths: new Set(paths), timer });
}

/** Buffer at most `limit` bytes; null once the stream exceeds it (stop reading, don't finish buffering). */
async function readBounded(req: Request, limit: number): Promise<Uint8Array | null> {
	if (!req.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of req.body) {
		total += chunk.byteLength;
		if (total > limit) return null;
		chunks.push(chunk);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function setupHint(workspaceId: string): string {
	return `expected OTLP/HTTP JSON — set OTEL_EXPORTER_OTLP_PROTOCOL=http/json and OTEL_EXPORTER_OTLP_ENDPOINT to this host's ${METRICS_INGEST_PREFIX}${workspaceId}`;
}

export async function handleMetricsIngest(req: Request, pathname: string): Promise<Response> {
	const match = INGEST_PATH.exec(pathname);
	if (!match?.[1]) return json(404, { error: "unknown ingest path" });
	const workspaceId = decodeURIComponent(match[1]);
	if (req.method !== "POST") return json(405, { error: "POST only" });
	let workspace: Workspace;
	try {
		workspace = getWorkspace(workspaceId);
	} catch {
		return json(404, { error: `unknown workspace: ${workspaceId}` });
	}
	const contentType = req.headers.get("content-type") ?? "";
	if (!contentType.includes("json")) {
		return json(415, { error: setupHint(workspaceId) });
	}
	const declaredLength = Number(req.headers.get("content-length") ?? "0");
	if (declaredLength > MAX_BODY_BYTES) return json(413, { error: "payload too large" });
	let body: unknown;
	try {
		const bytes = await readBounded(req, MAX_BODY_BYTES);
		if (bytes === null) return json(413, { error: "payload too large" });
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return json(400, { error: setupHint(workspaceId) });
	}
	const parsed = parseOtlpTraces(body);
	if (!parsed) return json(400, { error: setupHint(workspaceId) });
	const changedPaths = recordSpans(
		workspaceId,
		workspace.worktreePath,
		parsed.serviceNames,
		parsed.spans,
	);
	log.debug(
		`ingested ${parsed.spans.length}/${parsed.totalSpans} attributed spans for workspace ${workspaceId}`,
	);
	queuePublish(workspaceId, changedPaths);
	return json(200, { partialSuccess: {} });
}

export function resetMetricsPublisher(): void {
	setMetricsPublisher(null);
	publishThrottleMs = DEFAULT_PUBLISH_THROTTLE_MS;
}
