---
id: module-evals
type: module-design
status: active
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
  `deriveEventMetrics` is pure over **structurally typed** events (`{ type, … }`), so it accepts
  contracts' `PiEvent` or pi's own events without importing either; tokens/cost are **sums of
  pi-reported per-message usage**, never recomputed from text. `deriveArtifactMetrics(cwd, baseRef)`
  assumes a **throwaway trial workspace whose start state is committed as `baseRef`**: it runs
  `git add -A` first (so new files/directories diff cleanly) — never point it at a user workspace.
  Detector git failures (bad ref, non-repo cwd) **throw** so the runner records a crashed trial —
  they are never converted into clean-looking empty metrics.
  Comment counting is a declared heuristic (added diff lines starting with the language's comment
  token, by extension map; shebangs and non-code files excluded). Validation commands run via POSIX
  `sh -c` with a per-command timeout — a phase-1 dev-CLI assumption, not a product contract.
- **Fixture promotion & replay** — session transcript + baseline marker → fixture bundle (replayed
  inputs vs reference baseline); replay reconstructs the start-state into a throwaway git workspace
  (clone the fixture's source repo → detach at the recorded head → apply the dirty patch → commit
  "trial baseline" as the detectors' `baseRef`). The clone's `origin` remote is **removed
  immediately** — a trial agent running `git push` must have nothing to push to; the user's live
  repo is read once at clone time and never writable from a trial. **Fixtures are not
  self-contained:** replay needs
  the source repo to still exist and contain the recorded head — it fails loudly otherwise
  (bundling full history per fixture was rejected as unbounded disk for large repos; revisit if
  fixture portability is ever needed). Promotion refuses an empty replay script (no user turns) and
  duplicate fixture ids; `extractSessionSeed` parses pi's `session.jsonl` structurally (user turns,
  last model/thinking-level) and skips malformed lines.
- **Runner** — applies one condition per fresh isolated trial session, N trials per condition under
  budget tripwires (turns / tool calls / wall time / spend), one JSONL `TrialRecord` per trial; a
  crash records a failed deterministic verdict, never silence. Sessions arrive through the injected
  `TrialSessionFactory` (`{ cwd, condition, onEvent } → { sessionId, prompt, abort?, dispose }`) —
  the consumer binds it to a real agent; the runner never imports one. Trials run **sequentially**;
  a tripped trial budget stops further turns (and calls `abort` when offered) and records
  `budget-exceeded`; the experiment-level cost cap stops **launching** later trials — skipped
  trials produce no records (the report simply shows fewer trials), which is honest rather than
  fabricating untried rows. Two optional consumer hooks: `shouldStop` (checked before each trial —
  the embedder's cancellation seam; stopping mid-trial is the embedder's job via the session it
  handed out) and `onTrialRecord` (fires after each record is appended — live progress for a UI).
- **Report** — per-condition aggregation and deltas consumed by the eval CLI
  (`summarizeByCondition` groups in first-seen order; `renderReport` shows outcome counts,
  pass rates, and averages with deltas against the first condition).

## The phase-1 CLI consumer

`scripts/run-evals.ts` (`bun run eval promote | run | report`) is the dev binding — a root script,
deliberately outside this package so the package never touches `@thinkrail/server`:

- `promote` reads the session-baseline marker + pi `session.jsonl` and calls `promoteFixture`
  (fixtures land under `<dataDir>/evals/fixtures/`). Sessions older than baseline capture are
  refused with a clear message.
- `run` binds `TrialSessionFactory` to `@thinkrail/server/agent` (`createSession`/`promptSession`/
  `abortSession`), using an **isolated `PI_CODING_AGENT_DIR`** under `<dataDir>/evals/agent-dir`
  with the developer's auth/models/settings copied in — trial sessions never pollute the
  developer's own session history. Knobs the binding cannot yet enforce (specs toggle, skill set,
  prompt variant) **fail loudly** instead of being silently ignored; model + thinking level are the
  supported phase-1 treatments.
- `report` aggregates `<dataDir>/evals/trials.jsonl` (optionally per experiment id).

## Boundary

- **Allowed deps:** pi types (type-only from `pi-ai` / `pi-agent-core` roots where possible),
  `@earendil-works/pi-coding-agent` (server-side session types), Node. The **session factory is
  injected** by the consumer (dev CLI now, host later) — this package never imports
  `@thinkrail/server`, so phase-2 host integration adds no cycle.
- **Forbidden:** `apps/*`, `@thinkrail/contracts` edits from here (phase 2 adds wire types in
  contracts, referencing these schemas by shape), browser code, CI/commit-gate wiring (evals spend
  real tokens, on demand only).
- Fixtures and trial records live under the ThinkRail data dir (`~/.thinkrail/evals/…` — the
  consumer passes that root; it is never an in-repo path). This is also why the workflow harness's
  `*.md`-masking concern does not apply here: fixture bundles never sit inside a project tree, so
  project spec discovery can never glob them.

## Relationship to the workflow test harness

[[module-workflow-tests]] keeps its own harness; this package generalizes its *patterns* (event
log subscriber, isolated per-trial agent dirs, budget tripwires, run-record JSONL, simulated-user
ladder) for arbitrary coding tasks. Migrating the harness onto these modules is deliberately out of
scope for phase 1.
