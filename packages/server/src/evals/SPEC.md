---
id: submodule-server-evals
type: submodule-design
status: draft
title: server/evals — experiment lifecycle host module
parent: module-server
references: [module-evals, submodule-server-session-baseline]
tags: [evals]
---

## Responsibility

The host side of the in-app experiment lifecycle (architecture Decision #20, phase 2): fixture and
experiment stores under `<dataDir>/evals/`, session→fixture promotion, and the **single active
run** per host — orchestrating `@thinkrail/evals`' `runExperiment` and projecting progress to
clients. `host` owns the WS handlers and injects everything agent-flavored; this module never
imports `agent`.

## Contract

- **Stores.** Fixtures live where [[module-evals]] puts them (`<dataDir>/evals/fixtures/<id>/`)
  plus a host-owned `project.json` sidecar (`{ projectId }`) — the package stays product-agnostic,
  the host owns project scoping. Experiments are wire-shaped JSON envelopes
  (`<dataDir>/evals/experiments/<id>.json`, `{ projectId, experiment }`). Trial records append to
  the same `<dataDir>/evals/trials.jsonl` the dev CLI uses — one corpus, two consumers.
- **Promotion** (`promoteSession`): resolves the session file via pi's `SessionManager.list(cwd)`
  (cwd = the workspace's worktree; lazy `PI_CODING_AGENT_DIR` resolution per the repo rule), reads
  the [[submodule-server-session-baseline]] marker, and delegates to the package's
  `promoteFixture`. No marker, an `unavailable` marker, or an unknown session fail with the
  explanatory message the UI shows verbatim.
- **One active run.** `startRun` refuses while a run is live and **verifies the confirmed budget**:
  the wire's `EvalConfirmedBudget` must equal the stored experiment's trial budget, experiment cost
  cap, and computed total trial count — the explicit-spend-confirmation contract lives here, not in
  the client. The host passes the `TrialSessionFactory` into `startRun`; the module wraps it to
  track the active trial (cost ticks summed from pi-reported usage events) and to let `stopRun`
  abort the live session while `shouldStop` skips the rest. A finished, crashed, or stopped run
  always publishes a terminal update — never a stuck "running" state.
- **Push.** `setEvalsPublisher` (the standard publisher-injection seam) broadcasts `EvalUpdatePush`
  (run state + just-appended trial records); updates are throttled to ~1 s except lifecycle edges
  (start/trial-end/terminal), which always publish.
- Wire↔package mapping (`EvalExperiment` ↔ `Experiment`, `TrialRecord` → `EvalTrialRecord`) is this
  module's job; neither contracts nor the package knows the other.

## Boundary

- **Allowed deps:** `@thinkrail/evals`, `@thinkrail/contracts` (wire types),
  `@earendil-works/pi-coding-agent` (`SessionManager.list` for session-file resolution),
  `session-baseline` (marker reads), `log`, `persistence` (`dataDir`), Node.
- **Forbidden:** `agent` (the session factory arrives injected from `host` — the reviews-pattern
  composition), `host`, anything browser-side.
