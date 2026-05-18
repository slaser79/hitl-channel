---
id: reply-buffer-contract
title: "ReplyBuffer Contract — peek+commit, monotonic sequence, wsSendAccepted"
type: lesson
products: [hitl-channel]
last_updated: 2026-05-18
---

# Pre-publish gate (per empire-implement §5.7)

- [x] Doctrine verified at: commit `8639aa0` (hitl-channel main) | 4-cycle bot review + 2× clean Approve on R4 + admin-merge
- [x] If retiring prior doctrine, retraction lands in THIS commit, not a follow-up — N/A (no prior reply-buffer doctrine)
- [x] Hypothesis sections explicitly labelled as such — none in this lesson
- [x] Frontmatter `last_updated` matches verification date (2026-05-18)

# Overview

SPEC-HITL-CC-001 Phase 4 AC#26 shipped a per-instance in-memory reply buffer that activates when `broadcastReply` is called with no OPEN WS client. The original sketch was "queue and drain", but the bot rinse surfaced four real defensive contracts that became part of the public shape. Future work on `src/reply_buffer.ts` or `src/http_bridge.ts`'s drain path MUST preserve all four — auto-reviewers will quote them back at PR time.

# Named Lessons

## 1. Peek + per-entry commit — NOT destructive drain

**Symptom:** If `drain()` clears the buffer BEFORE the `ws.send` loop confirms each entry, a WS that drops mid-loop permanently loses every un-sent entry (they've been removed from the buffer, but were never delivered).

**Root Cause:** "Drain to client" is two operations — read every entry AND remove every entry. Coupling them at the start of the loop means failures during the iteration can't roll back the removal. PR #11 R1 P0 caught this.

**Fix:** `ReplyBuffer.peek()` returns a non-destructive snapshot in arrival order; `ReplyBuffer.commit(entry)` removes one entry by reference. The drain loop calls `peek()` once, then per-entry `ws.send → commit on success`. If `ws.readyState` transitions out of OPEN mid-loop (or `ws.send` returns ≤0 — see Lesson 3), the loop breaks and un-committed entries stay in the buffer for the next reconnect. `drain()` is retained as a convenience helper = peek + commit-all, intended for tests + shutdown paths where the entire batch is known-delivered.

**Rule:** Never expand `drain()` use into production WS-delivery paths. Production = peek + commit.

## 2. Sort by monotonic `sequence`, NOT wall-clock `queuedAt`

**Symptom:** Under backward system-clock skew between two `push()` calls, sorting by `queuedAt` reorders entries and violates the "arrival order" contract in AC#26.

**Root Cause:** Wall-clock is not monotonic. NTP slew, manual clock adjust, leap-second handling, sandbox-clock-injection (in tests) can all push the clock backward — even by milliseconds. Sort comparators are non-deterministic across such adjustments.

**Fix:** `ReplyBuffer` carries a private `nextSequence: number` counter (assigned at `push` time, monotonically increasing for the buffer's lifetime). The internal `BufferedReplyEntry` extends `BufferedReply` with a `sequence: number` field. `peek()` sorts by `sequence`, not `queuedAt`. `queuedAt` is retained for TTL eviction + oldest-buffered-age math, where small skew is tolerable (the audit field is `floor(seconds)` precision).

**Companion rule (PR #11 R3 P3#1):** Inside `drainBufferToClientSync`, the `oldest_buffered_seconds` audit field MUST be `min(queuedAt) across peeked` — NOT `peeked[0].queuedAt`. The sequence-sort first entry is the earliest-pushed by sequence, but under clock rollback its `queuedAt` may not be the wall-clock minimum.

**Rule:** When ordering matters AND timestamps are wall-clock, separate the ordering signal (monotonic seq) from the time-measurement signal (queuedAt). Don't conflate them.

## 3. `wsSendAccepted(ws, data)` helper — Bun's `ws.send` return value is load-bearing

**Symptom:** Pre-fix code called `ws.send(data)` and proceeded as if it succeeded. Bun's `ServerWebSocket.send` returns bytes-sent: `> 0` success, `0` if dropped due to backpressure, `-1` if socket already closed. Treating any return as success caused: (a) drain to commit an entry that was never delivered (data loss), (b) `broadcastReply` to count a backpressure-drop as `sent>0` and suppress the buffer-push fallback (data loss).

**Root Cause:** `ws.send`'s type signature is `number`, but the failure semantics aren't disambiguated by the sig alone. Agents tend to treat vendored runtime primitives (Bun ws, Deno serve, Node ws, Dart sink, Python asyncio writer) as language built-ins and skip the contract probe. They are not built-ins — they are vendor-controlled contracts with surprise-shape behaviour. Cross-ref `empire-implement` SKILL.md §1.5-runtime.

**Fix:** Single helper at `src/http_bridge.ts`:
```ts
function wsSendAccepted(ws: HitlWebSocket, data: string): boolean {
  try {
    const result = ws.send(data);
    return typeof result !== "number" || result > 0;
  } catch {
    return false;
  }
}
```

Apply at **every** send site: `broadcastFrame`, `broadcastReply`, `drainBufferToClientSync`. The `try/catch` guards against vendor-shaped exceptions (closed-socket throw rather than return). The `typeof result !== "number"` clause is for test mocks returning `void`/`undefined` (no backpressure surface — treated as success).

**Rule:** Any new send site in this repo MUST route through `wsSendAccepted` — DO NOT call `ws.send` directly. If you need raw `send` access (e.g. for performance-critical paths), document why and add a regression test for the backpressure path.

## 4. Drain idempotency makes `clients.size === 1` guard unnecessary

**Symptom:** Pre-fix, the WS `open` handler guarded the drain with `if (clients.size === 1)` to prevent "double-replay" when a second client reconnected. With a stale/non-responsive client lingering in `clients` (not yet evicted by the `close` handler), the guard would SKIP the drain entirely for the legitimate reconnecting second client.

**Root Cause:** The guard pattern assumed the drain operation needed external coordination to prevent double-delivery. With peek+commit, the operation is already idempotent at the data-structure level — a second concurrent drain calls `peek()`, sees an empty buffer (because the first drain already committed every entry), and returns zero.

**Fix:** Remove the `clients.size === 1` guard. Open handler calls `drainBufferToClient` unconditionally. The first reconnecting WS drains; any subsequent reconnect during the same window peeks empty and exits. No double-send, no audit double-emit.

**Rule:** When a data-structure operation has natural idempotency (commit-by-reference, write-if-absent, compare-and-swap), don't bolt external guards on top. The guards become liveness bugs when the assumed pre-condition breaks (stale client, partial close, network split).

## 5. Sync sends before any await — race-freedom by construction

**Symptom:** A `void drainBufferToClient(ws)` call in the open handler creates a microtask. If the wrapper has an early `await` BEFORE the `ws.send` loop, the open handler can return — letting a subsequent `broadcastReply` call run and send NEW frames to the same client BEFORE the buffered HISTORICAL frames are sent. Client receives messages out of arrival order.

**Root Cause:** Async-fn body executes synchronously until the first `await`. If the sends are AFTER the first `await`, they're microtask-deferred — and Bun's single-threaded event loop can interleave other handlers between `clients.add(ws)` and the deferred sends.

**Fix:** Split into two functions:
- `drainBufferToClientSync(ws, buffer): {sent, oldestQueuedAt}` — pure synchronous. Sends complete inside the call; no awaits.
- `drainBufferToClient(ws, buffer, audit?, nowMs?): Promise<number>` — async wrapper. Invokes `drainBufferToClientSync` first (no awaits before it), then `await audit(...)` for the JSONL emit.

Open handler uses `void drainBufferToClient(ws).catch(...)`. The wrapper's sync portion runs to completion BEFORE returning the promise — sends happen synchronously, audit emit is fire-and-forget. Bun runs WS handlers single-threaded, so no `broadcastReply` can interleave between `clients.add(ws)` and the sync send loop. Race-free by construction.

**Rule:** When you need "send-then-audit" inside a sync handler context, factor the side-effect chain so the load-bearing sync part has NO awaits before it. Reserve `await` for the trailing-fire-and-forget side effects (audit, logging, metrics).

# What was declined twice as groundwork (do not re-implement)

The bot rinse asked twice for **per-WS routing by `agent_id`** (R2 P2#2 "multi-device gap" and R3 P1 "per-bucket routing"). Both were declined. The `agent_id` on `BufferedReply` is the buffer's BUCKET KEY (cap-per-agent), NOT a WS routing target — the phone routes the reply internally by reading the `agent_id` field on the delivered payload. Implementing per-WS routing requires the phone-side protocol to declare its `agent_id` at WS handshake; PR A (`slaser79/hitl-app#4049`) already shipped without that contract, so adding the relay side now would be groundwork for an architecture that doesn't exist.

If multi-device-per-CC ever becomes a real product requirement, this lesson is the deferral marker — file a fresh spec amendment with the phone-side handshake change first.

# Cross-references

- Originating issue: `slaser79/hitl-channel#10`
- Shipping PR: `slaser79/hitl-channel#11` (squash-merged as `8639aa0` on 2026-05-18 after 4 rinse cycles)
- Umbrella: `slaser79/hitl-app#4043` (SPEC-HITL-CC-001 Phase 4 — stays open pending on-device runbook signoff)
- Sibling-repo Phase 6 carry-forward: `slaser79/hitl-channel#12` (audit-fields `attachment_count` + `attachment_bytes`)
- Operating-env doctrine: `empire-implement` SKILL.md §1.5-runtime (vendored runtime primitives as contracts), §6.4a (intra-cycle bot disagreement)
