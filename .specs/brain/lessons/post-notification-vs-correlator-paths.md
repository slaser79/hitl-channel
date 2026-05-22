---
id: post-notification-vs-correlator-paths
title: "POST / vs WS — two response surfaces, only WS resolves correlator"
type: lesson
products: [hitl-channel]
last_updated: 2026-05-22
---

# Pre-publish gate (per empire-implement §5.7)

- [x] Doctrine verified at: hitl-channel PR #18 (commit `150b284`, merged `be3b9e2`) | live CEO debug session 2026-05-22 — `present_questions_to_hitl` blocked for full timeout window because phone-side reply went via POST → notification path, never WS → correlator
- [x] If retiring prior doctrine, retraction lands in THIS commit, not a follow-up — N/A (no prior doctrine on this asymmetry; SPEC-AW-311 §4.1 originally assumed correlator path, PR #18 retracted it)
- [x] Hypothesis sections explicitly labelled as such — none in this lesson; entirely empirically verified
- [x] Frontmatter `last_updated` matches verification date (2026-05-22)

---

# POST / vs WS — two response surfaces, only WS resolves correlator

## Symptom

An MCP tool that uses `correlator.register + await waiter` (e.g. SPEC-AW-311's original `present_questions_to_hitl`) blocks for the full `timeout_seconds` window even after the user clearly submitted an answer on the phone. CEO sees the tool call sitting idle and has to manually cancel.

## Root cause

The phone has **two** response surfaces back to the channel server, and they route to different code paths:

1. **HTTP `POST /` (notification surface)** — the phone calls `claudeCodeService.sendMessage(message)` which `POST`s the entire message JSON. The handler at `src/http_bridge.ts:354` reads `body.message` / `body.content` and forwards the text to `sendChannelNotification(mcp, ...)`. **It does NOT call `correlator.resolve`.** The `metadata` field on the POST body is read for nothing and discarded entirely.
2. **WebSocket inbound frame (`/ws message` handler at `src/http_bridge.ts:429-490`)** — the phone sends a structured frame over the open WS. ONLY this path triggers `correlator.resolve(reqId, data)` (lines 467 onward), and ONLY for `frameType` in `{tool_call_result, list_tools_result, questions_batch_result}`.

The phone-side Flutter code uses HTTP POST for user-typed replies, choice submissions, and (pre-fix) questions_batch submissions. None of them reach the correlator.

## Fix

Two complementary rules:

1. **Any new MCP tool registered in `server.ts` that wants a synchronous round-trip MUST use a WS-based response path.** If the phone responds via HTTP POST, do NOT use `correlator.register + await waiter` — the waiter has no way to resolve. Either:
   - Implement the response on the phone as a WS frame send (and add the `frameType` to the resolver branch in `http_bridge.ts:441`), OR
   - Make the tool **fire-and-forget** like `present_choices_to_hitl` (`server.ts:383-426`) — broadcast the frame, return immediately. The user's response arrives later as a normal channel notification.

2. **`present_choices_to_hitl` is the canonical fire-and-forget shape; copy-adapt from it when adding sibling tools.** It broadcasts a `{type: 'choices', ...}` WS frame, audits dispatch, returns `"Choices presented to user: ..."` without registering a waiter. SPEC-AW-311 PR #18 retrofitted `present_questions_to_hitl` to this shape after the blocking-tool bug was demonstrated live.

## Rule

**Before adding any `correlator.register + await waiter` to a new MCP tool, confirm the phone's response path is WS, not HTTP POST.** Grep the Flutter side for the response-dispatch code (typically `claudeCodeService.sendMessage` vs `channel.sink.add`). If POST, you have two choices: switch the phone to WS, or drop the waiter and go fire-and-forget. Picking neither = the tool will block for the full timeout window every time, with no log noise to explain why.

## Sibling concern — structured-metadata propagation

The POST `/` handler also DROPS the `metadata` field entirely. A phone reply with `metadata: {type, batch_id, batch_answer: {...}}` reaches the agent as plain `"Submitted N answers"` text — the structured payload is lost. Tracked as a follow-up in [hitl-channel#19](https://github.com/slaser79/hitl-channel/issues/19). Until that lands, do NOT rely on structured payloads surviving the POST → notification round-trip; if you need the data on the agent side, encode it into the human-readable content OR switch the phone to WS dispatch.

## Cost-of-not-doing reference

SPEC-AW-311 closeout session 2026-05-22: ~25 min wall-clock spent on "why did my call sit blocked even after CEO answered" before the asymmetry surfaced. CEO interrupt cost: one full manual-cancel + "please check implementation vs single choices" redirect. The doctrine codified here would have routed the design to fire-and-forget from PR #17 (the initial AW-311 spec landing), saving the PR #18 follow-up entirely.

## Related

- `src/server.ts:383-426` — `present_choices_to_hitl` canonical fire-and-forget shape
- `src/http_bridge.ts:354-400` — POST `/` notification handler (no correlator)
- `src/http_bridge.ts:429-490` — WS message handler (correlator-resolution path)
- `src/questions_batch.ts` — current `present_questions_to_hitl` (fire-and-forget post-PR #18)
- hitl-channel#18 — fire-and-forget retrofit PR
- hitl-channel#19 — follow-up tracking structured-metadata propagation gap
- [empire-implement skill](~/.claude/skills/empire-implement/SKILL.md) §1.5 + §3.7 — generic "probe external contracts" + "forward-incompatibility" doctrine this is an instance of
