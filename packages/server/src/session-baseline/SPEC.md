---
id: submodule-server-session-baseline
type: submodule-design
status: active
title: server/session-baseline — per-session start-state markers
parent: module-server
references: [module-evals]
tags: [evals]
---

## Responsibility

Capture a cheap **baseline marker** for every new parent chat session: the workspace's git state at
session start (HEAD sha, branch, and — when dirty — one binary patch covering staged, unstaged, and
untracked-but-not-ignored changes). The marker is what later lets any past session be promoted to an
eval fixture retroactively ([[module-evals]]): transcript from pi's session file, start-state
workspace reconstructed as `checkout <head>` + `git apply <patch>`.

## Contract

- `captureSessionBaseline(sessionId, cwd)` — **never throws, never blocks session creation**: the
  host fires it and forgets it right after a session is born; failures log a warning and still write
  a marker whose `git` field records what could not be captured.
- Markers live under `<dataDir>/session-baselines/` as `<sessionId>.json` (atomic tmp+rename) plus
  `<sessionId>.patch` when dirty. `readSessionBaseline(sessionId)` reads one back.
- The dirty patch is produced against a **temporary index** (`GIT_INDEX_FILE`: `read-tree HEAD` →
  `add -A` → `write-tree` → `diff --binary HEAD <tree>`), so the user's real index is never touched
  and untracked files are included while ignored files are not. A clean tree skips all patch work.
- **Bounded honesty over completeness:** a patch above 8 MiB is not stored (`patchOmitted:
  "too-large"`, size recorded). The cap is enforced **before** the temp-index pipeline too —
  `add -A` even against a temp index writes blob objects into the repo's real `.git/objects`, and a
  500 MB untracked artifact must not cost that disk on every chat start. The pre-check scans
  `status --porcelain -z -uall` (NUL-separated so non-ASCII names are never quoted away; `-uall` so
  files inside untracked directories are listed individually, not collapsed to `dir/`) and
  short-circuits when dirty files' **summed** on-disk sizes exceed the cap — deliberately
  conservative: a large tracked file with a one-line edit is skipped as `too-large` even though its
  delta would have been small. A failed patch pipeline records `patchOmitted: "capture-failed"`;
  a non-git or unborn-HEAD cwd records `state: "unavailable"` with the reason. A marker never lies
  about covering state it didn't capture.
- **Retention:** each capture opportunistically prunes markers older than 90 days. Markers are
  advisory local evidence, not domain state — no wire surface, no hydration.

## Hazard

The capture races the session's first work by design (fire-and-forget at creation). This is
accepted: the first agent edit requires a user prompt that arrives on a later wire call, so the scan
completes long before any mutation in practice. Do not "fix" this by awaiting capture inside session
creation — a multi-second `add -A` scan on a large repo would tax every new chat.

## Boundary

- **Allowed deps:** `git` (the `gitAsync` runner + `nonInteractiveGitEnv`), `persistence`
  (`dataDir`), `log`, Node.
- **Forbidden:** `agent` (the host composes capture beside `createSession`; this module never
  touches sessions), anything on the wire.
