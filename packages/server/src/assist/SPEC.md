---
id: submodule-server-assist
type: submodule-design
status: active
title: assist — ad-hoc one-shot tasks
parent: module-server
depends-on: [submodule-server-agent]
tags: [pi, oneshot, public-surface-checked]
---

## Responsibility

Small, **best-effort** agentic helpers that run a single cheap-model completion — the "ad-hoc one-shot
task service." Each task owns its prompt, output parsing/guards, and graceful-degrade fallback; it never
blocks or crashes its caller. The current task drafts a completed plan's summary when the agent wrote none.
Assist never names workspaces, branches, or chats — naming is manual or agentic (the `rename_session` tool;
see [[submodule-server-agent]]). The tasks are a **library surface** — no wire method; consumers are
host-side flows.

## Boundary

- **Owns:**
  - The task catalog + their prompts, output guards, and fallbacks. Every task is time-boxed
    (`AbortSignal.timeout`) and bounded (`maxTokens`).
  - `suggestPlanSummary(steps)` → a short **Markdown** handoff note for a COMPLETED plan, drafted from its
    finished steps (`{ title, summary?, verification? }[]`, built by the caller — assist reads no store),
    through the tool-free cheap-model path, or `null` (best-effort: `null`, never throws, on no auth /
    timeout / no usable steps / empty output). `toPlanSummary(raw)` is the pure output guard (strip a code
    fence and a leading `Summary:` label, clamp length; `null` when empty). The host persists the result
    only when non-null; it never overwrites an agent-authored `plan.summary`.
  - `setOneShotRunner(fn)` — a test seam swapping the one-shot runner (default = `agent.completeOnce`) so
    tasks unit-test against a fake with no pi/auth/network.
- **Public surface (barrel):** `setOneShotRunner`, `suggestPlanSummary`, `toPlanSummary`, `OneShotRunner`,
  `PlanSummaryStep`.
- **Allowed deps:** `agent` (the `completeOnce`/`OneShotRequest`/`OneShotResult` primitive, via its
  barrel); Node.
- **Forbidden:** `host`; **`@earendil-works/pi-ai` / `pi-coding-agent` directly** (model access + dispatch
  belong to `agent`); reaching into another feature's internals.

## Get right

- Every task **degrades to `null`** — a failure must never block its caller or surface as an error. Wrap the
  runner call; the caller decides what to do without a result.
- Never trust model formatting: cap `maxTokens`, then normalize/clamp the text yourself.
- These are stateless, side-effect-free `fetch`es on the shared loop (no disk, no tools) — safe to run in
  parallel; no manager/registry needed.
