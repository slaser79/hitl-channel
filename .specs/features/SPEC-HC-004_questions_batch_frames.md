---
id: SPEC-HC-004
title: "Batched-question WS frames — present_questions_to_hitl"
status: "Draft"
owner: "hitl-channel"
created_by: "cos"
last_updated: 2026-05-20
products: ["hitl-channel"]
depends_on: ["SPEC-AW-311", "SPEC-HITL-CC-001"]
---

# Batched-question WS frames — `present_questions_to_hitl`

## 1. Executive Summary

SPEC-AW-311 defines a batched human-input contract — `QuestionSpec` + `QuestionAnswer` records — that lets an agent pose 1–4 related questions in one MCP call and receive one structured payload. SPEC-HITL-APP-4116 owns the mobile renderer. This spec defines the **LAN-side wire**: a new `present_questions_to_hitl` MCP tool on the hitl-channel server that ships ONE `questions_batch_request` WebSocket frame to the paired phone, registers ONE waiter in the existing `FrameCorrelator` (same proven pattern as `tool_call_*` and `list_tools_*` from SPEC-HITL-CC-001 Phase 1), and resolves it when the device sends back ONE `questions_batch_result` frame. The new tool sits next to the existing single-question `present_choices_to_hitl`; the new frames sit next to the existing `tool_call_request` / `tool_call_result` / `list_tools_*` frame pair — no new transport machinery is introduced.

## 2. CEO Business Outcomes

- [ ] Agents on the LAN/Tailscale channel can pose batched questions and receive one structured answer payload — closing the same "drawn-out interrogation" UX pain on the LAN path that SPEC-AW-311 closes on the cloud path (Verified by CV1).
- [ ] Mobile + agent + channel all speak ONE wire vocabulary (`QuestionSpec` / `QuestionAnswer`) regardless of pairing transport — the user gets one survey UX whether they're paired over LAN or over the cloud relay (Verified by CV2).
- [ ] New frames inherit the audit + correlator + reply-buffer machinery already shipped for `tool_call_*` — no new persistence, no new closed-schema variants beyond two enum values (Verified by AV3, AV4).
- [ ] Existing single-question `present_choices_to_hitl` continues to work unchanged — zero regression for already-paired agents (Verified by AV5).

## 3. User Stories

- As an **agent author** paired over hitl-channel, I want to call `present_questions_to_hitl([Q1, Q2, Q3])` and `await` a single structured response, so that I don't have to write three sequential `present_choices_to_hitl` calls and stitch the answers together.
- As an **empire engineer** maintaining the LAN wire, I want the batched-frame round-trip to use the SAME `FrameCorrelator` and audit shape as `tool_call_*`, so that I don't have two parallel inference paths to keep in sync when the transport evolves.
- As a **paired-phone user** who happens to have weak Wi-Fi mid-survey, I want the batched survey to drain from the reply-buffer when my WebSocket reconnects, so that I don't lose the question because the agent's call fired while the channel was briefly down.

## 4. Technical Implementation & Architecture

### 4.0 Target State — the end-state picture in one read

When this spec ships, the hitl-channel MCP server exposes a sibling to `present_choices_to_hitl` called `present_questions_to_hitl` that accepts a list of 1–4 `QuestionSpec` records and returns a `{answers, cancelled}` payload. The new tool is a strict structural sibling of the existing `call_phone_tool` from SPEC-HITL-CC-001 Phase 1: it generates a UUID `request_id`, registers a waiter in the existing `FrameCorrelator` with a configurable timeout, broadcasts one `questions_batch_request` frame to all connected clients, and awaits the device's `questions_batch_result` frame to resolve the waiter. There is no new transport, no new correlator, no new persistence — the round-trip rides exactly the rails the round-trip MCP-tool pattern already runs on.

Two new closed-schema frame types are added to the existing union in `types.ts`. `QuestionsBatchRequestFrame` carries `{type: "questions_batch_request", request_id, questions: list<QuestionSpec>, ts}`. `QuestionsBatchResultFrame` carries `{type: "questions_batch_result", request_id, answers: list<QuestionAnswer>, cancelled: boolean}`. The shapes mirror the relay-side schema from SPEC-AW-311 byte-for-byte so a payload captured on one transport is structurally identical on the other; mobile renderers and agent callers both speak one vocabulary.

Audit emission piggybacks on the existing pattern. The dispatch side emits one closed-schema audit row with `direction: "cc_to_phone"` and a new `kind: "questions_batch"` value — `prompt_hash` is computed over the canonical JSON of `questions`, `attachment_count` and `attachment_bytes` are zero. The result side reuses the existing tool-result audit branch with the same `direction: "phone_returns_to_cc"` and the new `kind: "questions_batch"`, `prompt_hash` over `answers`. The audit log stays closed-schema, single-row-per-side, no PII leak risk beyond what the prompt hash already mitigates.

The reply-buffer / drain-on-reconnect behaviour from SPEC-HITL-CC-001 Phase 4 (AC#26) covers `questions_batch_request` frames automatically because the buffer keys on instance identity, not on frame type. A frame queued while no client is connected drains in order when the client reconnects; the device-side renderer mounts the survey as expected. No additional buffer wiring is needed.

There is no chat-message-row threading on the channel side; batched surveys are routed by the device into the chat-history surface owned by SPEC-HITL-APP-4116. The channel server's job ends at the WS frame.

### 4.1 Architecture

```
Agent (Claude Code) ── MCP tool ──▶ hitl-channel server
                                          │
                                          ├─ generate UUID request_id
                                          ├─ correlator.register(request_id, timeout)
                                          ├─ broadcastFrame({type: "questions_batch_request", ...})
                                          ├─ audit({direction: cc_to_phone, kind: "questions_batch"})
                                          ├─ await waiter
                                          │
                                          ▼
                                    paired phone (WS)
                                          │
                                          │ user fills survey, taps Submit / Cancel
                                          │
                                          ▼
hitl-channel server ◀── WS message ── {type: "questions_batch_result", request_id, answers, cancelled}
        │
        ├─ correlator.resolve(request_id, payload)
        ├─ audit({direction: phone_returns_to_cc, kind: "questions_batch"})
        │
        ▼
   tool returns {answers, cancelled} dict to Agent
```

Failure modes (all already handled by the existing correlator):

- **Phone disconnected at dispatch**: `broadcastFrame` delivers to 0 clients → correlator is rejected synchronously with `no_phone_connected_post_check`.
- **Phone disconnected mid-flight**: connection-drop handler calls `correlator.rejectAll(...)`; the pending waiter rejects with the connection error.
- **Timeout**: configurable per call (default 300s, ≤900s hard cap); the correlator's existing timeout machinery handles it.
- **Stale / unknown result frame**: `correlator.resolve()` returns false for unknown `request_id`; server.ts logs a warn-level line and drops the frame (existing idempotency contract).

### 4.2 Components

**Reuse contract — the new wire piggybacks on existing patterns:**

- `FrameCorrelator` (in `src/correlator.ts`) — **reused as-is**. No changes. The new `questions_batch_request` round-trip registers a waiter via `correlator.register(reqId, timeoutMs)` and the result frame resolves via `correlator.resolve(reqId, payload)`. Same shape as `tool_call_*`.
- Reply buffer (in `src/reply_buffer.ts`) — **reused as-is**. `questions_batch_request` frames are buffered per-instance and drained on WS reconnect via the existing AC#26 mechanism. No change.
- Audit log (in `src/audit.ts`) — **extension only**. Adds one new value to the existing `kind` enum (`"questions_batch"`). Closed-schema invariant is preserved — every new audit row spreads named fields explicitly.

**New surfaces (final count: 1 MCP tool + 2 closed-schema frame types):**

- New MCP tool `present_questions_to_hitl` (in `src/server.ts`) — strict structural sibling of `call_phone_tool` from SPEC-HITL-CC-001 Phase 1. Signature: `(questions: list<QuestionSpec>, timeout_seconds?: number)` with input-schema constraint `1 <= len(questions) <= 4`. Generates UUID, registers correlator waiter, broadcasts frame, awaits result, returns `{answers, cancelled}` MCP response.
- New frame type `QuestionsBatchRequestFrame` (in `src/types.ts`) — `{type: "questions_batch_request", request_id: string, questions: QuestionSpec[], ts: string}`.
- New frame type `QuestionsBatchResultFrame` (in `src/types.ts`) — `{type: "questions_batch_result", request_id: string, answers: QuestionAnswer[], cancelled: boolean}`.
- `QuestionSpec` / `QuestionAnswer` TypeScript interfaces (in `src/types.ts`) — mirror of the relay-side pydantic shapes from SPEC-AW-311. `QuestionSpec = {header: string, question: string, choices: string[], multi_select?: boolean, allow_other?: boolean}`. `QuestionAnswer = {header: string, selected: string[], other_text?: string}`.
- WS-inbound routing branch (in `src/http_bridge.ts`) — extension on the existing `type === "tool_call_result" || type === "list_tools_result"` discriminator at the WS message handler. Add `|| type === "questions_batch_result"` to the same closed-schema-resolve branch; payload validation rejects frames missing `request_id` or `answers`.

**Pre-authoring extension-sites check (per empire-spec §4.2 doctrine):**

- *Why a new MCP tool `present_questions_to_hitl`, not an extension to `present_choices_to_hitl`?* Same rationale as the relay-side decision in SPEC-AW-311 §4.2: the existing tool's signature is single-prompt-shaped; threading a `questions: list` parameter through it would produce a union-shaped input (`prompt+choices` OR `questions[]`) and a union-shaped output (`free-text-via-channel-message` OR `{answers, cancelled}`) — strictly worse for callers. A sibling tool is structurally clean and is the same pattern hitl-channel already follows with `call_phone_tool` next to single-tool dispatchers.
- *Why new `questions_batch_*` WS frame types, not parameter extension on `tool_call_*` frames?* `tool_call_*` carries `(name, arguments)` semantics — invoking a named tool on the device. A batched-survey request is a structurally different operation: there's no tool name, the device's response shape is a fixed `BatchAnswer`, and the renderer is the survey widget rather than a per-tool handler. Forcing the batched survey through `tool_call_request` (as "call the 'show_survey' tool") would conflate two contracts.
- *Why one `questions_batch_request` frame type, not separate per-question frames?* The whole point of the spec is one round-trip per batch. K separate frames would defeat the purpose, lose the atomicity guarantee, and reintroduce the per-question correlation problem the relay-side spec was written to solve.
- *Why no new audit `kind` for the dispatch + result, instead of reusing `tool_result`?* The dispatch direction needs its own `kind` because `prompt_hash` is computed over `questions` (not `arguments`). The result direction could reuse `tool_result` but the audit consumer would have to know to interpret `prompt_hash` differently based on context — adding a dedicated `questions_batch` value is one closed-schema variant for both directions and removes that conditional. Audit consumers stay simple.

### 4.3 UI/UX & Design System Adherence

This spec is the wire layer; UX is owned by SPEC-HITL-APP-4116. The wire enforces:

- `len(questions)` is bounded 1–4 at the MCP-input-schema level (matches relay-side constraint; matches the single-screen survey design constraint).
- `QuestionSpec` field validation (header ≤12 chars, question ≤1000 chars, choices 2–4) is enforced at the MCP-input-schema level so malformed agent calls are rejected before a frame is broadcast.
- `request_id` is opaque to the mobile renderer; the device echoes it back in `questions_batch_result` without interpreting it.

There is no in-process UI surface on the hitl-channel server side.

### 4.4 DRY & KISS Principles

- **Reuse the existing correlator.** No new correlator, no new pending-Promise machinery. The round-trip uses exactly the `register / resolve / reject` API that `tool_call_*` and `list_tools_*` already use.
- **Reuse the existing reply-buffer.** SPEC-HITL-CC-001 Phase 4 AC#26 buffers any outbound frame keyed by instance; `questions_batch_request` frames are buffered automatically with no new wiring.
- **Reuse the existing audit closed-schema.** Add one new `kind` value (`"questions_batch"`) used by both dispatch and result rows. No new audit-log file format, no new schema variant.
- **One vocabulary across transports.** `QuestionSpec` / `QuestionAnswer` TypeScript interfaces are the JSON-serialisable mirror of the relay-side pydantic shapes from SPEC-AW-311. A payload captured on either transport is structurally identical.
- **No new persistence on the channel side.** Surveys are routed by the device into the chat-history surface owned by SPEC-HITL-APP-4116; the channel server's job ends at the WS frame. No survey row, no per-batch state in `src/`.
- **No backward-compat layer.** Existing `present_choices_to_hitl` continues to work unchanged for single-question callers. The new tool is purely additive.

## 5. Delivery Plan

### Phase 1: MV Spec
- **Scope:** MCP tool `present_questions_to_hitl` end-to-end with correlator + audit + reply-buffer integration; `questions_batch_request` and `questions_batch_result` frame types in `types.ts`; WS-inbound routing branch in `http_bridge.ts`; closed-schema audit rows; bun test coverage of the round-trip.
- **CEO Outcome:** Agents paired over hitl-channel can pose batched questions and get a structured answer back — the LAN-path counterpart to SPEC-AW-311's cloud-path capability.

### Phase 2: Other-text passthrough
- **Scope:** When the relay-side schema gains `allow_other` on `QuestionSpec` (SPEC-AW-311 Phase 2), this spec passes the field through end-to-end. Channel side has no semantic work — `QuestionSpec` is opaque JSON to the channel; only the `QuestionAnswer.other_text` field needs to round-trip without being dropped by validation.
- **CEO Outcome:** Phase 2 of the relay + mobile work lights up on the LAN path without a separate channel-side spec.

## 6. Regression Analysis & Testing Strategy

### 6.1 Regression Risks

- **Type-discriminator drift in WS handler.** The existing `type === "tool_call_result" || type === "list_tools_result"` branch at the WS message handler must accept `"questions_batch_result"` without breaking the existing two branches. Mitigation: bun test asserting all three result frame types resolve correctly via the correlator.
- **Audit-schema enum exhaustiveness.** Adding a new `kind` value must not break the existing audit-line shape consumers. Mitigation: structural test asserting closed-schema appendAudit accepts the new kind and emits the existing fields.
- **Reply-buffer TTL semantics.** A `questions_batch_request` frame buffered for >24h would drain after the agent's MCP call has already timed out (correlator default 300s, hard cap 900s). The phone would render a stale survey for a request the agent has given up on. Mitigation: device-side renderer SHOULD treat the frame's `ts` field as a freshness gate (this is mobile-side work; called out here for cross-spec awareness, not enforced in the channel layer). No-op on the channel side — the existing TTL behaviour is preserved as-is.
- **`request_id` collision with `tool_call_request`.** Both new and existing round-trips share the `FrameCorrelator`'s key space. Mitigation: both flows generate UUIDs via the existing `generateRequestId()` helper; the correlator already rejects duplicate IDs synchronously per its register() contract.
- **No regression in `present_choices_to_hitl`.** The existing single-question path must continue to work. Mitigation: full existing bun test suite passes unchanged.

### 6.2 Testing Strategy

- **Unit (bun test):** `QuestionsBatchRequestFrame` / `QuestionsBatchResultFrame` JSON shape; payload validator rejects malformed frames (missing `request_id`, malformed `answers`); audit-line emission for both dispatch and result; closed-schema invariant preserved.
- **Integration (bun test):** end-to-end `present_questions_to_hitl` round-trip with a mock WS client — tool call → frame dispatched → mock client replies with `questions_batch_result` → tool returns expected payload. Connection-drop mid-flight scenario rejects the waiter. Timeout scenario fires after configured time.
- **Regression (bun test):** the existing `tool_call_*` and `list_tools_*` round-trip tests continue to pass; the existing `present_choices_to_hitl` audit test continues to pass.

## 7. Acceptance Criteria

### Agent-verifiable (CI)

- [ ] **AV1** MCP input-schema validation rejects: `len(questions) < 1`, `len(questions) > 4`, `len(choices) < 2`, `len(choices) > 4`, `len(header) > 12` (5 bun test cases).
- [ ] **AV2** `present_questions_to_hitl` happy-path bun test with a mock WS client: tool dispatch emits exactly one `questions_batch_request` frame; correlator has exactly one registered waiter; mock client replies with `questions_batch_result`; correlator resolves; tool returns `{answers, cancelled}` payload with the right shape and order.
- [ ] **AV3** Audit emission: one closed-schema row with `direction: "cc_to_phone", kind: "questions_batch"` is appended on dispatch; one row with `direction: "phone_returns_to_cc", kind: "questions_batch"` on result; `prompt_hash` differs between the two (one hashes `questions`, the other `answers`); `attachment_count` and `attachment_bytes` are zero on both.
- [ ] **AV4** Reply-buffer integration: with no client connected, calling `present_questions_to_hitl` buffers the `questions_batch_request` frame; on client reconnect the frame drains in order; the mock client receives it intact.
- [ ] **AV5** Regression: the existing `present_choices_to_hitl`, `call_phone_tool`, `list_phone_tools`, `reply_to_hitl` bun test suites pass unchanged.
- [ ] **AV6** Timeout: `present_questions_to_hitl` with `timeout_seconds: 1` and no client reply rejects with a timeout error after the configured interval; correlator is empty after the rejection.
- [ ] **AV7** Connection drop: a `questions_batch_request` dispatched then the WS client disconnects → the pending waiter rejects via `correlator.rejectAll(...)`; tool call surfaces the connection error to the MCP caller.
- [ ] **AV8** Frame routing in WS handler: a malformed `questions_batch_result` (missing `request_id`) is logged at warn level and dropped; the existing `tool_call_result` / `list_tools_result` branches continue to resolve correctly in the same handler call.

### CEO / external-verify (work-with-CEO on device)

- [ ] **CV1** LAN round-trip on a real Claude Code pairing: an MCP client calls `present_questions_to_hitl` with 3 questions (one multi-select); the paired iPhone receives ONE WS frame; the user opens the chat screen, sees the survey inline, answers, taps Submit; the agent receives one structured `{answers, cancelled: false}` payload with all 3 answers correctly populated. `STATUS: UNVERIFIED — work-with-CEO`.
- [ ] **CV2** Cross-transport consistency walk: the same 3-question fixture invoked via cloud (`request_human_input_multiple`) and via LAN (`present_questions_to_hitl`) produces visually identical surveys on the phone and structurally identical `BatchAnswer` payloads in the agent. `STATUS: UNVERIFIED — work-with-CEO`.
- [ ] **CV3** Reconnect-replay on flaky Wi-Fi: dispatch a `present_questions_to_hitl` while the phone's WS is briefly disconnected; reconnect within the reply-buffer TTL (24h); the survey appears on reconnect; user answers; agent receives the payload. `STATUS: UNVERIFIED — work-with-CEO`.

## 7a. User-Story → AC Traceability

| User story phrase | AC # | Notes |
|---|---|---|
| "call `present_questions_to_hitl([Q1, Q2, Q3])` and `await` a single structured response" | AV2, CV1 | tool round-trip |
| "don't have to write three sequential `present_choices_to_hitl` calls" | AV2 | one tool call → one return |
| "use the SAME `FrameCorrelator` and audit shape as `tool_call_*`" | AV2, AV3 | correlator + audit emission tests |
| "two parallel inference paths" (negated — should NOT exist) | §4.2 reuse contract | no new correlator, no new buffer, no new audit format |
| "drain from the reply-buffer when my WebSocket reconnects" | AV4, CV3 | buffer integration + reconnect test |

## 7b. Doctrine carry-forward (inline-paraphrased)

- **Closed-schema audit emission.** Every new audit-row emission must spread named fields explicitly; never dump caller-supplied JSON into the audit log even via a single field. Batch payloads contain user prompts which may include PII; `prompt_hash` is the only field carrying that content, and it MUST be a deterministic hash, not a passthrough. *Origin: SPEC-HITL-CC-001 issue #12 closed-schema rule (paraphrased — the rule is the load-bearing part, not the PR reference).*
- **`request_id` is a UUID, generated server-side.** Callers MUST NOT supply their own. The correlator's `register()` rejects duplicates synchronously; UUID collision is the only failure mode that bypass the rejection, and UUIDs are collision-free for practical purposes. Sibling rule to the SPEC-HITL-CC-001 Phase 1 `tool_call_request` flow.
- **`type`-first routing in WS handler.** Control frames MUST never fall through to the chat-notification path. A `questions_batch_result` arriving for an unknown / already-resolved `request_id` is logged at warn level and dropped — no waiter, no audit double-count. *Origin: SPEC-HITL-CC-001 §4.2 type-first routing rule.*
- **Reactive schema growth.** The MV schema is the narrow union of what real callers need today (`header / question / choices / multi_select`). `allow_other`, `default_selected`, `validation_regex` are NOT in MV; they belong in Phase 2 when a real caller demands them. *Origin: empire YAGNI doctrine, codified in multiple brain lessons.*
- **No load-bearing PR references.** Every doctrine carried here is paraphrased inline so the spec survives if the PR linkage rots. *Origin: empire-spec §7b.*
