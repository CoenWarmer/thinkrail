---
id: module-evals
type: module-design
status: draft
title: packages/evals — eval/experiment framework (headless foundation)
parent: architecture
references: [module-workflow-tests, submodule-server-agent]
tags: [evals, testing, pi]
---

## Responsibility

Controlled experiments measuring ThinkRail's **quality and cost** on coding tasks (architecture
Decision #20 owns the experimental model and its rejected alternatives). This package owns:

- **Schemas** — `Fixture`, `Condition` (treatment), `Experiment`, `TrialRecord`: serializable,
  contracts-ready (no server-internal types), so a later phase lifts them onto the wire unchanged.
- **Capture** — event-derived metrics from a passively subscribed session event stream (model, tool
  use, tokens, duration, compaction point, subagent prompts, spec-tool use) plus artifact detectors
  over the resulting workspace/diff (validation commands pass, comments introduced, files touched).
- **Fixture promotion & replay** — session transcript + baseline marker → fixture bundle (replayed
  inputs vs reference baseline); replay reconstructs the start-state into a throwaway git workspace.
- **Runner** — applies one condition per fresh isolated trial session, N trials per condition under
  budget tripwires (turns / tool calls / wall time / spend), one JSONL `TrialRecord` per trial; a
  crash records a failed deterministic verdict, never silence.
- **Report** — per-condition aggregation and deltas consumed by the eval CLI.

## Boundary

- **Allowed deps:** pi types (type-only from `pi-ai` / `pi-agent-core` roots where possible),
  `@earendil-works/pi-coding-agent` (server-side session types), Node. The **session factory is
  injected** by the consumer (dev CLI now, host later) — this package never imports
  `@thinkrail/server`, so phase-2 host integration adds no cycle.
- **Forbidden:** `apps/*`, `@thinkrail/contracts` edits from here (phase 2 adds wire types in
  contracts, referencing these schemas by shape), browser code, CI/commit-gate wiring (evals spend
  real tokens, on demand only).
- Fixtures and trial records live under `~/.thinkrail`; nothing is committed to the repo.

## Relationship to the workflow test harness

[[module-workflow-tests]] keeps its own harness; this package generalizes its *patterns* (event
log subscriber, isolated per-trial agent dirs, budget tripwires, run-record JSONL, simulated-user
ladder) for arbitrary coding tasks. Migrating the harness onto these modules is deliberately out of
scope for phase 1.
