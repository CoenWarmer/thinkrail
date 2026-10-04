import type { MetricsSummary } from "@thinkrail/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";

/** Client view tuning: the host reports `lastReceivedAt` facts; this threshold decides the verdict. */
const RECEIVING_WINDOW_MS = 30_000;

export type MetricsStatus = "never" | "receiving" | "stale";

export function metricsStatus(summary: MetricsSummary | null, now: number): MetricsStatus {
	if (!summary || summary.lastReceivedAt === null) return "never";
	return now - summary.lastReceivedAt <= RECEIVING_WINDOW_MS ? "receiving" : "stale";
}

function relativeAge(ms: number): string {
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	return `${Math.round(min / 60)}h ago`;
}

const DOT_BY_STATUS: Record<MetricsStatus, string> = {
	never: "bg-text-muted",
	receiving: "bg-feedback-success",
	stale: "bg-feedback-warning",
};

/** The chat-toolbar runtime-metrics ingest indicator — always visible; its popover is the primary
 * setup discovery surface (the copy-paste ingest URL + the OTLP http/json requirement). */
export function MetricsIndicator({
	summary,
	now,
	ingestUrl,
}: {
	summary: MetricsSummary | null;
	now: number;
	ingestUrl: string | null;
}) {
	const status = metricsStatus(summary, now);
	const services = summary?.services.join(", ") ?? "";
	const endpoint = ingestUrl?.replace(/\/v1\/traces$/, "") ?? null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid="metrics-indicator"
					data-status={status}
					aria-label="Runtime metrics"
					className="flex shrink-0 items-center gap-4 whitespace-nowrap text-text-muted tr-text-metadata hover:text-text-default"
				>
					<span aria-hidden className={cn("size-6 rounded-full", DOT_BY_STATUS[status])} />
					metrics
				</button>
			</PopoverTrigger>
			<PopoverContent
				data-testid="metrics-popover"
				align="end"
				className="flex w-[360px] max-w-[calc(100vw-24px)] flex-col gap-8 tr-text-ui"
			>
				<div className="tr-title-dialog">Runtime metrics</div>
				<div className="text-text-muted">
					{status === "never"
						? "No metrics received yet. Point your running app's OpenTelemetry exporter at this workspace to see call counts and latencies here and in the file editor."
						: status === "receiving"
							? `Receiving${services ? ` from ${services}` : ""} — ${summary?.totalSpans ?? 0} spans, ${summary?.locationCount ?? 0} code locations.`
							: `Stale — last received ${summary?.lastReceivedAt != null ? relativeAge(now - summary.lastReceivedAt) : ""}${services ? ` from ${services}` : ""}.`}
				</div>
				{endpoint ? (
					<div className="flex items-center gap-4">
						<code
							data-testid="metrics-ingest-url"
							className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] bg-sunken px-8 py-4 tr-code-text"
						>
							{endpoint}
						</code>
						<CopyButton getText={() => endpoint} label="Copy ingest URL" className="opacity-100" />
					</div>
				) : null}
				<div className="text-text-subtle">
					Set <code className="tr-code-text">OTEL_EXPORTER_OTLP_PROTOCOL=http/json</code> and{" "}
					<code className="tr-code-text">OTEL_EXPORTER_OTLP_ENDPOINT</code> to this URL. Only
					OTLP/HTTP JSON is accepted.
				</div>
			</PopoverContent>
		</Popover>
	);
}
