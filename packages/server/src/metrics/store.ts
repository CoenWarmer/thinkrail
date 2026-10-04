import { isAbsolute, normalize, relative, sep } from "node:path";
import type { MetricsFileAnnotation, MetricsLocation } from "@thinkrail/contracts";

export interface SpanObservation {
	rawPath: string;
	functionName: string;
	line: number;
	durationMs: number;
	error: boolean;
}

export interface IngestStatus {
	lastReceivedAt: number | null;
	services: string[];
	totalSpans: number;
	locationCount: number;
}

const HIST_BUCKETS = 44;
const BUCKET_MS = 30_000;
const WINDOW_BUCKETS = 30;
const WINDOW_MS = BUCKET_MS * WINDOW_BUCKETS;
export const MAX_LOCATIONS_PER_WORKSPACE = 2000;
const MAX_SERVICES = 20;

interface Agg {
	count: number;
	errorCount: number;
	maxMs: number;
	hist: Uint32Array;
}

interface WindowBucket {
	start: number;
	agg: Agg;
}

interface LocationAggregate {
	relPath: string | null;
	rawPath: string;
	functionName: string;
	line: number;
	total: Agg;
	buckets: WindowBucket[];
	lastSeen: number;
}

interface WorkspaceMetrics {
	locations: Map<string, LocationAggregate>;
	services: Set<string>;
	lastReceivedAt: number | null;
	totalSpans: number;
}

const workspaces = new Map<string, WorkspaceMetrics>();

function createAgg(): Agg {
	return { count: 0, errorCount: 0, maxMs: 0, hist: new Uint32Array(HIST_BUCKETS) };
}

function histIndex(ms: number): number {
	const idx = Math.floor((Math.log10(Math.max(ms, 1e-3)) + 3) * 4);
	return Math.min(HIST_BUCKETS - 1, Math.max(0, idx));
}

function histValue(index: number): number {
	return 10 ** ((index + 0.5) / 4 - 3);
}

function addToAgg(agg: Agg, ms: number, error: boolean): void {
	agg.count += 1;
	if (error) agg.errorCount += 1;
	if (ms > agg.maxMs) agg.maxMs = ms;
	const idx = histIndex(ms);
	agg.hist[idx] = (agg.hist[idx] ?? 0) + 1;
}

function mergeAgg(target: Agg, source: Agg): void {
	target.count += source.count;
	target.errorCount += source.errorCount;
	if (source.maxMs > target.maxMs) target.maxMs = source.maxMs;
	for (let i = 0; i < HIST_BUCKETS; i++)
		target.hist[i] = (target.hist[i] ?? 0) + (source.hist[i] ?? 0);
}

function quantile(agg: Agg, q: number): number {
	if (agg.count === 0) return 0;
	const target = Math.max(1, Math.ceil(agg.count * q));
	let cumulative = 0;
	for (let i = 0; i < HIST_BUCKETS; i++) {
		cumulative += agg.hist[i] ?? 0;
		if (cumulative >= target) return Math.min(histValue(i), agg.maxMs);
	}
	return agg.maxMs;
}

function workspaceEntry(workspaceId: string): WorkspaceMetrics {
	let entry = workspaces.get(workspaceId);
	if (!entry) {
		entry = { locations: new Map(), services: new Set(), lastReceivedAt: null, totalSpans: 0 };
		workspaces.set(workspaceId, entry);
	}
	return entry;
}

/** Workspace-relative POSIX path, or null when the span's path does not resolve into the worktree. */
export function normalizeSpanPath(rawPath: string, worktreePath: string): string | null {
	const rel = isAbsolute(rawPath) ? relative(worktreePath, rawPath) : normalize(rawPath);
	if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return null;
	return sep === "/" ? rel : rel.split(sep).join("/");
}

function pruneWindow(location: LocationAggregate, now: number): void {
	location.buckets = location.buckets.filter((b) => now - b.start < WINDOW_MS);
}

function windowAgg(location: LocationAggregate, now: number): Agg | null {
	pruneWindow(location, now);
	if (location.buckets.length === 0) return null;
	const merged = createAgg();
	for (const bucket of location.buckets) mergeAgg(merged, bucket.agg);
	return merged;
}

function evictIfNeeded(entry: WorkspaceMetrics): void {
	while (entry.locations.size > MAX_LOCATIONS_PER_WORKSPACE) {
		let oldestKey: string | null = null;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [key, location] of entry.locations) {
			if (location.lastSeen < oldestSeen) {
				oldestSeen = location.lastSeen;
				oldestKey = key;
			}
		}
		if (oldestKey === null) return;
		entry.locations.delete(oldestKey);
	}
}

export function recordSpans(
	workspaceId: string,
	worktreePath: string,
	serviceNames: readonly string[],
	spans: readonly SpanObservation[],
	now = Date.now(),
): Set<string> {
	const entry = workspaceEntry(workspaceId);
	entry.lastReceivedAt = now;
	entry.totalSpans += spans.length;
	for (const service of serviceNames) {
		if (entry.services.size < MAX_SERVICES) entry.services.add(service);
	}
	const changedPaths = new Set<string>();
	for (const span of spans) {
		const relPath = normalizeSpanPath(span.rawPath, worktreePath);
		const key = `${span.rawPath}\u0000${span.functionName}\u0000${span.line}`;
		let location = entry.locations.get(key);
		if (!location) {
			location = {
				relPath,
				rawPath: span.rawPath,
				functionName: span.functionName,
				line: span.line,
				total: createAgg(),
				buckets: [],
				lastSeen: now,
			};
			entry.locations.set(key, location);
		}
		location.lastSeen = now;
		addToAgg(location.total, span.durationMs, span.error);
		pruneWindow(location, now);
		let bucket = location.buckets.at(-1);
		if (!bucket || now - bucket.start >= BUCKET_MS) {
			bucket = { start: now, agg: createAgg() };
			location.buckets.push(bucket);
		}
		addToAgg(bucket.agg, span.durationMs, span.error);
		if (relPath !== null) changedPaths.add(relPath);
	}
	evictIfNeeded(entry);
	return changedPaths;
}

function toMetrics(location: LocationAggregate, now: number): MetricsLocation {
	const windowed = windowAgg(location, now);
	const agg = windowed ?? location.total;
	return {
		path: location.relPath,
		rawPath: location.rawPath,
		functionName: location.functionName,
		line: location.line,
		callCount: agg.count,
		errorCount: agg.errorCount,
		p50Ms: quantile(agg, 0.5),
		p95Ms: quantile(agg, 0.95),
		maxMs: agg.maxMs,
		windowed: windowed !== null,
	};
}

/** Hotness: recent (or lifetime, when the window is empty) p95 × call count. */
function score(metrics: MetricsLocation): number {
	return metrics.p95Ms * metrics.callCount;
}

export function topLocations(
	workspaceId: string,
	limit: number,
	now = Date.now(),
): MetricsLocation[] {
	const entry = workspaces.get(workspaceId);
	if (!entry) return [];
	const rows = [...entry.locations.values()].map((location) => toMetrics(location, now));
	rows.sort((a, b) => score(b) - score(a));
	return rows.slice(0, limit);
}

export function fileAnnotations(
	workspaceId: string,
	relPath: string,
	now = Date.now(),
): MetricsFileAnnotation[] {
	const entry = workspaces.get(workspaceId);
	if (!entry) return [];
	const rows: MetricsFileAnnotation[] = [];
	for (const location of entry.locations.values()) {
		if (location.relPath !== relPath) continue;
		const { line, functionName, callCount, errorCount, p50Ms, p95Ms, maxMs, windowed } = toMetrics(
			location,
			now,
		);
		rows.push({ line, functionName, callCount, errorCount, p50Ms, p95Ms, maxMs, windowed });
	}
	rows.sort((a, b) => a.line - b.line);
	return rows;
}

export function ingestStatus(workspaceId: string): IngestStatus {
	const entry = workspaces.get(workspaceId);
	if (!entry) return { lastReceivedAt: null, services: [], totalSpans: 0, locationCount: 0 };
	return {
		lastReceivedAt: entry.lastReceivedAt,
		services: [...entry.services].sort(),
		totalSpans: entry.totalSpans,
		locationCount: entry.locations.size,
	};
}

export function resetMetricsStore(): void {
	workspaces.clear();
}
