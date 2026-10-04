---
id: submodule-server-metrics
type: submodule-design
parent: module-server
status: active
title: metrics — OTLP ingest + per-workspace code-location aggregates
depends-on: [module-contracts]
---

## Responsibility

Receive OTLP/HTTP **JSON** trace exports pushed by a user's running application and hold them as
bounded, in-memory, per-workspace aggregates keyed by code location, for three consumers: the
`metrics_query` agent tool, the Monaco inline-metrics layer, and the chat-toolbar ingest indicator.
ThinkRail is the **receiver** — it never scrapes, polls, or queries an external metrics backend.

## Boundary

- **Owns:** the OTLP ingest request handler (`POST /ingest/otlp/:workspaceId/v1/traces`, wired into
  `host`'s route table like the file routes); the per-workspace aggregate store; the span→location
  reduction; the throttled `metrics.updated` publisher seam; the read surface behind
  `metrics.summary` / `metrics.forFile` and the agent-tool query handler.
- **Public surface (barrel):** the ingest handler, the reads (summary / file annotations / top
  locations for the agent tool), `setMetricsPublisher`, and a test reset seam.
- **Allowed deps:** `workspaces` (worktree cwd for path normalization), `contracts`, `log`,
  `persistence`-free — the store is memory-only by decision.
- **Forbidden:** `host`; sibling features; retaining raw spans; any outbound network.

## Decisions

- **Push model, workspace-scoped path.** The ingest URL's `:workspaceId` is attribution, not
  authentication — reachability is the auth (architecture decision #7). The operator points their
  app's standard OTel SDK at the workspace whose worktree the running build came from; two running
  versions push to two workspaces and never bleed.
- **OTLP/HTTP JSON only (v1).** Most SDKs default to `http/protobuf`; requiring
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` is the accepted cost of not shipping a protobuf decoder.
  Unknown/undecodable payloads are rejected loud (4xx), never silently dropped.
- **Aggregates, not spans.** Spans reduce on arrival to per-`(filepath, function, line)` stats —
  call count, error count, duration quantile sketch (p50/p95/max) — in a rolling bucketed window
  plus since-ingest totals. Raw spans are not retained. Cardinality is capped per workspace with
  LRU eviction, so a hostile or misconfigured producer cannot grow the host unbounded.
- **Code attribution comes from standard span attributes** (`code.filepath`, `code.lineno`,
  `code.function`). Paths are normalized against the workspace worktree cwd; locations outside the
  worktree stay queryable by the agent but yield no file annotations.
- **Memory-only.** A host restart drops aggregates; the still-running app re-fills the window.
  Dev-loop tool, not an observability store — persistence is a non-goal until proven needed.
- **The host reports facts, never liveness verdicts.** `lastReceivedAt` + service names cross the
  wire; "receiving / stale" thresholds are client view tuning (hydrate-then-stream invariant).
- **Line anchoring is version-true, not edit-true.** Metrics describe the *running* build; after
  local edits, annotations may sit on shifted lines until the app restarts and re-reports. Accepted
  for v1 with `lastReceivedAt` as the staleness signal; review-style selector re-anchoring is an
  explicit deferral.
- **Agent access is a host-bound tool, host-composed.** The `metrics_query` pi extension lives in
  `agent` and delegates through a handler `host` installs (the `reviews`/`resolve_comment` seam
  pattern) — no `agent` → `metrics` edge. A no-data result names the workspace's exact ingest URL
  and the `http/json` requirement rather than returning clean-looking emptiness.

## Deferrals

OTLP protobuf; OTLP metrics/logs signals; counters/gauges and exception capture; dashboard panel;
aggregate persistence; re-anchoring annotations across edits.
