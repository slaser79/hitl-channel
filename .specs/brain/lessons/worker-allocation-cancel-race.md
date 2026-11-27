---
id: worker-allocation-cancel-race
title: "Worker Allocation-Cancel Race — activeRunId vs stale workerContextBySessionId & closeAfterCancel"
type: lesson
products: [hitl-channel]
last_updated: 2026-11-27
---

# Pre-publish gate (per empire-implement §5.7)

- [x] Doctrine verified at: commit `ef2ba915` (`hitl-channel#56`, merged `5d932f64`) | CI `Typecheck + bun test` (`4/4` `test/phase2_squad_streaming.test.ts`, `tsc --noEmit` 0 errors) + `SM_F946B` CV5
- [x] If retiring prior doctrine, retraction lands in THIS commit, not a follow-up — N/A
- [x] Hypothesis sections explicitly labelled as such — none in this lesson
- [x] Frontmatter `last_updated` matches verification date (2026-11-27)

# Overview

Multi-turn worker orchestration (`SPEC-HITL-APP-10832` Phase 2a, `src/acp_session_manager.ts`) separates pre-allocation run registration (`workerRunsById`, populated synchronously on `host_run_start`) from post-allocation session binding (`workerSessions` / `workerContextBySessionId`, populated only after `await allocateWorkerSession(frame)`). Two concurrency races arise when `host_run_cancel` (`external_session_key` / `close_session`) arrives while `allocateWorkerSession` is in flight.

# Named Lessons

## 1. Never bind stale `workerContextBySessionId` completed run IDs over active allocating runs

**Symptom:** After Turn 1 completes on a persistent `external_session_key` (leaving `workerSessions[sid].activeRunId === null`, while `workerContextBySessionId[sid].runId` still points to Turn 1), sending `host_run_cancel` by `external_session_key` while Turn 2 is still awaiting `allocateWorkerSession` resolves `runState` to Turn 1 (`terminalEmitted === true`), skips scanning `workerRunsById`, leaves Turn 2 uncancelled, and immediately evicts the shared session if `close_session: true`.

**Root Cause:** `workerContextBySessionId` intentionally retains the last completed `runId` across idle turns, whereas `workerRunsById` holds the newly created `!terminalEmitted` Turn 2 `WorkerRunState` whose `sessEntry.activeRunId` has not yet been bound. Falling back to `workerContextBySessionId` during cancel resolution shadows the live pre-allocation run.

**Fix (`PR #56` `ef2ba915`):** In `handleHostRunCancel`, inspect only `entry.activeRunId` from `workerSessions`, and whenever `!runState || runState.terminalEmitted`, scan `workerRunsById` preferring `!candidate.terminalEmitted` before falling back to any completed match.

**Rule:** Any lookup by `external_session_key` targeting live/cancellable work MUST resolve `!terminalEmitted` entries in `workerRunsById` first and NEVER let post-completion context maps shadow an allocating turn.

## 2. Carry pending `closeAfterCancel` across pre-allocation cancellation

**Symptom:** When `host_run_cancel` arrives with `close_session: true` while a brand-new `external_session_key` session is still awaiting `allocateWorkerSession` (no `acp_session_id` or `workerSessions` entry exists yet), cancelling in the `!sid` branch drops `closeSession`. Once `allocateWorkerSession` resolves, `executeWorkerTurn` hits `if (runState.cancelled) return;` and leaks the newly allocated session open in `workerSessions`.

**Root Cause:** Pre-allocation `WorkerRunState` had `cancelled` and `cancelReason`, while `closeAfterTurn` lived only on `WorkerSessionEntry`, which does not exist until allocation completes.

**Fix (`PR #56` `ef2ba915`):** Store `closeAfterCancel?: boolean` on `WorkerRunState`, set it whenever `closeSession` is true during `handleHostRunCancel`, and call `await this.evictWorkerSession(sessionId)` inside the `if (runState.cancelled)` branch of `executeWorkerTurn` after `allocateWorkerSession` resolves.

**Rule:** Any lifecycle flag targeting a worker session whose allocation may still be in flight MUST have a pending representation on `WorkerRunState` and be reconciled on the `runState.cancelled` exit path after `allocateWorkerSession`.
