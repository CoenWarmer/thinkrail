import type { SpanObservation } from "./store";

export interface ParsedTraces {
	serviceNames: string[];
	totalSpans: number;
	spans: SpanObservation[];
}

interface OtlpAttribute {
	key?: unknown;
	value?: {
		stringValue?: unknown;
		intValue?: unknown;
		doubleValue?: unknown;
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function attrString(attributes: unknown, ...keys: string[]): string | null {
	for (const raw of asArray(attributes)) {
		const attr = raw as OtlpAttribute;
		if (typeof attr?.key !== "string" || !keys.includes(attr.key)) continue;
		const value = attr.value;
		if (typeof value?.stringValue === "string" && value.stringValue !== "")
			return value.stringValue;
	}
	return null;
}

function attrNumber(attributes: unknown, ...keys: string[]): number | null {
	for (const raw of asArray(attributes)) {
		const attr = raw as OtlpAttribute;
		if (typeof attr?.key !== "string" || !keys.includes(attr.key)) continue;
		const value = attr.value?.intValue ?? attr.value?.doubleValue;
		const parsed =
			typeof value === "string" ? Number(value) : typeof value === "number" ? value : null;
		if (parsed !== null && Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function nanos(value: unknown): number | null {
	const parsed =
		typeof value === "string" ? Number(value) : typeof value === "number" ? value : null;
	return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isErrorStatus(status: unknown): boolean {
	const code = asRecord(status)?.code;
	return code === 2 || code === "STATUS_CODE_ERROR";
}

/**
 * Parse an OTLP/HTTP JSON ExportTraceServiceRequest. Tolerant per-span (a span missing code
 * attribution still counts toward totals); loud per-request (a body without `resourceSpans` is not
 * OTLP and the caller rejects it).
 */
export function parseOtlpTraces(body: unknown): ParsedTraces | null {
	const root = asRecord(body);
	if (!root || !Array.isArray(root.resourceSpans)) return null;
	const serviceNames = new Set<string>();
	const spans: SpanObservation[] = [];
	let totalSpans = 0;
	for (const rawResourceSpans of root.resourceSpans) {
		const resourceSpans = asRecord(rawResourceSpans);
		if (!resourceSpans) continue;
		const service = attrString(asRecord(resourceSpans.resource)?.attributes, "service.name");
		if (service) serviceNames.add(service);
		for (const rawScopeSpans of asArray(resourceSpans.scopeSpans)) {
			for (const rawSpan of asArray(asRecord(rawScopeSpans)?.spans)) {
				const span = asRecord(rawSpan);
				if (!span) continue;
				totalSpans += 1;
				// Both the stable and the pre-1.x OTel code-attribute names are accepted.
				const rawPath = attrString(span.attributes, "code.file.path", "code.filepath");
				const functionName = attrString(span.attributes, "code.function.name", "code.function");
				const line = attrNumber(span.attributes, "code.line.number", "code.lineno");
				const start = nanos(span.startTimeUnixNano);
				const end = nanos(span.endTimeUnixNano);
				if (rawPath === null || functionName === null || start === null || end === null) continue;
				const durationMs = Math.max(0, (end - start) / 1e6);
				spans.push({
					rawPath,
					functionName,
					line: line !== null && line >= 1 ? Math.floor(line) : 1,
					durationMs,
					error: isErrorStatus(span.status),
				});
			}
		}
	}
	return { serviceNames: [...serviceNames], totalSpans, spans };
}
