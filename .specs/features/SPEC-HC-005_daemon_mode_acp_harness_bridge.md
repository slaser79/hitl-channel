---
id: SPEC-HC-005
title: "Daemon mode — hitl-channel as an ACP client so the phone can drive any harness (agy first)"
status: "Draft"
owner: "hitl-channel"
created_by: "cos"
last_updated: 2026-11-21
products: ["hitl-channel"]
depends_on: ["SPEC-HC-001", "SPEC-HC-003", "SPEC-HC-004", "SPEC-HITL-CC-001"]
---

# Daemon mode — hitl-channel as an ACP client so the phone can drive any harness (agy first)

> **Provenance.** Brainstormed with the CEO via HITL MCP on 2026-11-21 (brief: `.specs/_pending/BRAINSTORM-hitl-channel-daemon-acp.md`, committed alongside this spec). An `agy acp` 1.5.11 spike on the same day passed every check this spec relies on (§4.1 "Verified protocol facts").
>
> **Sibling positioning.**
> - **SPEC-HC-001 / 002 / 003** (pairing, mDNS, channel messaging): *extended*. Daemon mode reuses all three unchanged on the phone-facing side and adds a second "bottom half".
> - **SPEC-HC-004** (questions batch frames): *disjoint*. Still available to daemon-mode agents through the injected tool set.
> - **SPEC-HITL-CC-001** (CC companion agent, phone tool bridge, workflow delegation): *extended*. Daemon mode brings that tool bridge and the delegation ceremony to non-Claude harnesses.
> - **Name collision warning:** in `hitl-shin-relay`, "ACP" means *Awesome ChatGPT Prompts* (SPEC-AW-278). In this spec, ACP always means the **Agent Client Protocol** (agentclientprotocol.com).

## 1. Executive Summary

Today the phone can only push into, and receive from, a **Claude Code** session. Claude Code's research-preview `notifications/claude/channel` capability is the only inbound path hitl-channel has, and Claude Code itself spawns hitl-channel as a stdio MCP child. Every other harness the CEO uses (Antigravity `agy`, Hermes, Codex) is limited to the relay-based HITL MCP. That path only talks one way, long-polls a socket for ~15 minutes, cannot start a new session, and cannot inject a message into a running one. This spec adds a **daemon mode** to hitl-channel. `hitl-channel daemon --harness agy` is a long-lived process that **spawns the harness's ACP server and acts as its ACP client**, while keeping the phone-facing HTTP/WS surface, pairing, allowlist, mDNS, reply buffer, correlator and audit **byte-for-byte unchanged**. Phone messages become `session/prompt`. The agent's turn text comes back as the existing `reply` frame. ACP permission requests become the existing `choices` frame. The phone tool bridge (`call_phone_tool`, `list_phone_tools`, `push_file`, …) is injected into every ACP session as a localhost MCP server, so a remote agent can drive the phone exactly as Claude Code can today. Sessions are created, listed and resumed from the phone with chat slash commands. **Phase 1 needs no hitl-app change and no relay**, which keeps the path relay-free for privacy-conscious users.

## 2. CEO Business Outcomes

- [ ] **From the phone, the CEO can start a brand-new Antigravity session on a chosen machine/folder and talk to it, without touching the keyboard.** This closes the current pain that only Claude Code can be reached, and only once a terminal session already exists. *(Verified by CV1, CV2.)*
- [ ] **A remote Antigravity agent can control the phone the same way a Claude Code agent can.** It can list and call phone tools, push files, and present choices, so desktop agents can build local agents, troubleshoot the app and run the dev loop on the phone. *(Verified by AV6, AV7, CV3.)*
- [ ] **The CEO approves or denies an agent's risky actions with one tap on the phone**, instead of the session silently stalling on a desktop prompt nobody is watching. *(Verified by AV8, CV4.)*
- [ ] **Messages never pass through a cloud intermediary.** Phone ↔ machine traffic stays on LAN/Tailscale/the user's own VPN, the same as CC channels today. *(Verified by AV12, CV5.)*
- [ ] **Existing Claude Code channel users see zero change.** The current `.mcp.json` setup, pairing and chat keep working exactly as before. *(Verified by AV1, AV13.)*

## 3. User Stories

- As **the CEO on my phone**, I want to type `/new agy ~/lab/hitl` in a paired machine's chat, so that a fresh Antigravity session starts in that folder and my next message goes to it.
- As **the CEO**, I want `/sessions` to list my recent agy sessions (title, folder, last activity) and `/resume <n>` to switch to one, so that I can pick up work the agent (or I) started earlier.
- As **the CEO**, I want a message sent mid-turn to queue, and `/cancel` to stop the running turn, so that I don't corrupt or lose work by typing while the agent is busy.
- As **the CEO**, I want the agent's permission requests to appear as tappable Allow / Deny choices in the chat, so that sessions don't stall on a desktop prompt.
- As **a privacy-conscious user**, I want daemon mode to work over my own LAN/Tailscale with the same pairing code flow, so that no third party sees my traffic.
- As **an Antigravity agent running under the daemon**, I want `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl` and `list_devices` available in my tool list, plus standing orders explaining them, so that I can act on the phone as if I were running on it.
- As **a hitl-app workflow step delegating to a host agent** (`ClaudeCodeAgentRunner`), I want the `<workflow_delegation message_id=X>` contract to resolve with the agent's final answer, so that workflows that delegate to "Claude Code" today also work against a daemon-backed agy instance.
- As **a Claude Code channel user**, I want the existing stdio/channel mode untouched, so that nothing I rely on regresses.

**Sibling-primitive audit.** The surface is *inbound delivery from the phone into the agent* plus *agent → phone frames*. Every primitive that flows through it:

| Primitive (phone → agent) | Call site today | Daemon-mode verdict |
|---|---|---|
| Chat message via `POST /` | `http_bridge.ts` POST handler → `sendChannelNotification` | → `session/prompt` on the active session (AV3) |
| Chat message via WS frame (no `type`) | WS `message` handler → `sendChannelNotification` | → same path as POST (AV3) |
| `choice_response` | POST `/` metadata | resolves a pending ACP permission if one exists (AV8). Otherwise forwarded as a prompt (AV3). |
| `questions_batch_response` | POST `/` formatted answers | forwarded as a prompt, using the existing formatting (AV3) |
| Pairing request notification | `/pair/request` → `sendChannelNotification` | → stdout + daemon log (AV2) |
| Attachments (images/files) | `processAttachments` | images → ACP image content blocks (agy `promptCapabilities.image: true`). Other files → existing inbox path mentioned in text (AV4). |
| `tool_call_result` / `list_tools_result` / `questions_batch_result` / `ack` | WS `type`-first routing → correlator | **unchanged**. Correlator owned by the shared bridge (AV6). |

| Primitive (agent → phone) | Daemon-mode verdict |
|---|---|
| `reply` frame | produced by the daemon at end of turn from collected `agent_message_chunk`s (AV5). The `reply_to_hitl` tool is **not** offered in daemon mode (§4.2). |
| `choices` frame | from `present_choices_to_hitl` (tool) **and** from ACP `session/request_permission` (AV8) |
| `questions_batch_request`, `tool_call_request`, `list_tools_request`, file push | via the injected MCP tools, same handlers (AV6, AV7) |

## 4. Technical Implementation & Architecture

### 4.0 Target State — the end-state picture in one read

hitl-channel has **one phone-facing half and two interchangeable agent-facing halves**. The phone-facing half is everything the app already knows: the HTTP endpoints, the WebSocket with its ACK protocol and reply buffer, pairing, the SHA-256 allowlist, mDNS advertisement, the frame correlator, and the audit log. It does not know or care which agent is behind it.

The first agent-facing half is today's **channel mode**. Claude Code spawns hitl-channel over stdio. Inbound messages become `notifications/claude/channel`, and the agent answers through the `reply_to_hitl` tool. Nothing about it changes.

The second agent-facing half is **daemon mode**. The user (or launchd/systemd) starts hitl-channel as a long-lived process naming a harness. The daemon spawns that harness's ACP server as its child and speaks ACP to it as the client. It owns a small **session manager**: the set of ACP sessions it has created or resumed, which one is *active* for chat, a FIFO of messages waiting for the current turn to finish, and any permission requests waiting on a phone tap. A **harness registry** maps a harness name to the command that starts its ACP server and the per-harness tweaks (agy first; Hermes and Codex later).

The **phone tool bridge is a shared tool module**, not something owned by either half. In channel mode it is served over Claude Code's stdio MCP connection. In daemon mode the same tool definitions and handlers are served over MCP Streamable HTTP on a loopback-only port, and that endpoint is injected into every ACP session's `mcpServers`, along with the standing orders appended to the agent's system prompt. Each tool call carries the ACP session id, so the daemon knows which session is driving the phone.

**Session control is a conversation, not a new protocol.** In Phase 1 the daemon intercepts a handful of slash commands in chat (`/new`, `/sessions`, `/resume`, `/cancel`, `/status`, `/help`) and answers them as ordinary replies. A later phase gives the app native session UI on top of the same session manager.

Everything stays **direct and relay-free**. Notifications remain local notifications the app raises from WS frames. The daemon never talks to hitlrelay.app.

### 4.1 Architecture

```
hitl-app (phone)                hitl-channel daemon (Bun, long-lived)                 agy acp (child)
     │  POST / , WS /ws  ───────▶ phone-facing half (UNCHANGED)
     │                            │  inbound sink ──▶ SessionManager ──session/prompt──▶│
     │                            │                      ▲  queue / active / pending    │
     │◀── reply frame ────────────┤◀── end-of-turn ──────┤◀── session/update chunks ────┤
     │◀── choices frame ──────────┤◀── permission ───────┤◀── session/request_permission┤
     │── choice_response ────────▶│──── outcome ─────────┴──────────────────────────────▶│
     │                            │
     │◀─ tool_call_request ───────┤◀── shared tool module ◀── MCP Streamable HTTP ◀─────│ (agent calls
     │── tool_call_result ───────▶│──── (correlator) ──────────▶ MCP result ───────────▶│  call_phone_tool)
```

**Turn lifecycle (one inbound message):**
1. The phone message arrives through the unchanged POST/WS handlers. The daemon's inbound sink receives `(content, meta)`. This is the same seam where channel mode calls `sendChannelNotification`.
2. If the content is a recognised slash command, the session manager handles it and answers with **one** `reply` frame. Nothing is sent to the agent.
3. Else, if a permission is pending on the active session and the message is a `choice_response` (or its text equals an option label, case-insensitively), the permission is resolved. **Exactly one** outcome is sent per `request_permission` id.
4. Else, if the active session has a turn running, the message is queued FIFO and the daemon sends a one-line "queued (n ahead)" reply.
5. Else, `session/prompt` is sent. `agent_message_chunk` text is collected. When the prompt's response (`stopReason`) arrives, the daemon calls the existing `broadcastReply()` **exactly once** with the collected text. The next queued message is then dequeued.
6. If the inbound content was wrapped in `<workflow_delegation message_id="X">…</workflow_delegation>`, that end-of-turn reply carries `message_id = X`. The app's `ClaudeCodeAgentRunner` resolves on the first reply whose `message_id` matches, so there is exactly one such reply per delegation by construction.

**Protocol invariants honoured.** One `reply` per prompt turn. One permission outcome per `request_permission` request id; late taps after resolution get a "no pending approval" reply. One MCP `tools/call` result per call id; the correlator already enforces this. One terminal state per turn (`end_turn`, `cancelled`, `max_tokens`, `refusal`, or an error surfaced as a reply).

**Verified protocol facts (agy acp 1.5.11 spike, 2026-11-21).** Every row was observed on the wire, not read from docs.

| Fact | Observed |
|---|---|
| `initialize` capabilities | `loadSession: true`; `sessionCapabilities` = `resume`, `close`, `load`, `list`, `additionalDirectories`; `promptCapabilities.image: true`; **no `mcpCapabilities` advertised** |
| stdio MCP in `session/new.mcpServers` | agent called the injected tool and returned its secret token |
| **HTTP** MCP (`{type:"http", url, headers}`) in `session/new` | works even though not advertised. agy probes `/.well-known/oauth-protected-resource` first and proceeds on 404/405. |
| Session attribution | every MCP `tools/call` carries `_meta["antigravity.google/conversation_id"]` = ACP `sessionId` |
| System-prompt injection | `session/new._meta.antigravity.systemPrompt.append` is honoured |
| Permission request | `session/request_permission` with options `{optionId:"allow",kind:"allow_once"}`, `{optionId:"deny",kind:"reject_once"}`, **including for injected MCP tools** |
| `session/list` | returns all agy ACP sessions in the app-data dir with `title`, `cwd`, `updatedAt` |
| Updates streamed | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `session_info_update` (auto title), `usage_update`, `available_commands_update` |
| User customizations | `agy acp` loads the user's hooks/plugins/skills. The CEO's agy **stop hook fired inside the spike sessions** and blocked each turn until answered (83 s / 176 s for a trivial turn). |

Classification of non-agy harnesses is **TENTATIVE until Phase 2 verifies on the wire**: Hermes (`hermes acp`) and Codex (via the Zed `codex-acp` adapter) are expected to fit the same mapping. Codex's HTTP-MCP support is unknown, and the stdio fallback is §4.2 item 6.

### 4.2 Components

Extension-sites checklist results. Each item says why an existing component can or cannot own the change.

1. **Inbound sink seam (extend `http_bridge.ts`; no new abstraction).** `startHttpBridge` currently takes the MCP `Server` and calls `sendChannelNotification` at three sites: pairing request, POST `/`, and the WS chat path. Change the parameter to a single function `deliverInbound(content, meta)`. Channel mode passes a closure over `sendChannelNotification`. Daemon mode passes the session manager's `handleInbound`. *Why not a new transport class:* the bridge already owns the phone side and only needs one function to call. A function parameter is the smallest change that makes both modes possible.
2. **Shared tool module (extract from `server.ts`).** The tool definitions and the `CallToolRequest` dispatcher (`list_devices`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_phone_tools`, `call_phone_tool`, `push_file`, and `reply_to_hitl` for channel mode only) move into a module that registers handlers on any MCP `Server` instance. `server.ts` (channel mode) keeps its exact current behaviour by registering all of them on its stdio server. *Why extract:* `server.ts` runs top-level `await mcp.connect(new StdioServerTransport())` on import (the same reason `mcp_instructions.ts` was already split out). Daemon mode cannot import it without hijacking stdio.
3. **Daemon entry point (`src/daemon.ts`, new, owned).** Parses `--harness`, `--port`, `--name`. Loads a **daemon-scoped identity** (see item 7). Starts the unchanged bridge with the session manager's sink. Starts mDNS (expected to fix issue #3 as a side effect, since the daemon is not a stdio subprocess). Serves the shared tool module over the MCP SDK's `StreamableHTTPServerTransport` (present in the pinned `@modelcontextprotocol/sdk` 1.27.1) on `127.0.0.1:<ephemeral>`. Reuses the existing graceful-shutdown pattern (signals, plus killing the child on exit). *Why new:* orthogonal lifecycle. Channel mode dies with Claude Code's stdin; the daemon must not.
4. **ACP client + session manager (`src/acp_session_manager.ts`, new).** Spawns the harness child and does `initialize`. Implements `session/new` (with `cwd`, `mcpServers: [hitl tools over http]`, and the `_meta` system-prompt append carrying the existing `MCP_INSTRUCTIONS`, adapted for daemon mode as below), `session/load`/`resume` (for `/resume`), `session/list`, `session/prompt`, and `session/cancel`. Handles the client side of `session/request_permission`. Holds `{activeSessionId, runningTurn, queue[], pendingPermissions[]}`. The ACP TypeScript SDK or a minimal ndjson JSON-RPC client are both acceptable. Pin the version, and keep stdout of the *child* separate from the daemon's own logging. *Why new:* no existing component speaks ACP. Grep confirms no prior art:
   ```
   $ grep -rniE "acp|daemon|session/(new|prompt)|spawn\(" src --include='*.ts' | grep -v __tests__
   src/reply_buffer.ts:9:  * - In-memory only — daemon restart clears the buffer ...   (comment only)
   src/reply_buffer.ts:13: *   two daemons (or two test fixtures) never share state.     (comment only)
   ```
5. **Daemon-mode standing orders (extend `mcp_instructions.ts`).** Add a `DAEMON_INSTRUCTIONS` export: the existing `STANDING_ORDERS` (call_phone_tool defaults, trust tiers gated on the phone) plus a daemon variant of the delegation ceremony. The variant says "your final turn text is delivered to the phone automatically, so do not call `reply_to_hitl`; for `<workflow_delegation>` envelopes, finish all work, then end the turn with your final answer". `reply_to_hitl` is **not registered** in daemon mode, so the agent cannot fire an early reply that resolves a delegation prematurely. *Why extend:* the instructions module already composes named blocks pinned by snapshot tests.
6. **Harness registry (small table inside the session manager; not its own file unless it grows).** `agy` → `agy acp` (HTTP MCP injection, `_meta.antigravity.systemPrompt.append`). Phase 2 adds `hermes` → `hermes acp` and `codex` → the codex-acp adapter, each marked `TBD-pending-wire-verify`. If a harness rejects HTTP MCP, fall back to a stdio shim: a `hitl-channel mcp-shim --session <id>` subcommand that proxies stdio to the daemon's loopback HTTP endpoint.
7. **Identity and port isolation (extend `identity.ts`).** Today identity is a single file `~/.hitl/channels/identity.json`. A daemon and a CC channel on the same host would advertise the **same `instanceId`**, which collides in the app's discovery and connection pool. Add an optional identity-file override (`HITL_CHANNEL_IDENTITY_FILE`). Daemon mode defaults it to `~/.hitl/channels/identity-daemon-<harness>.json`, display name defaults to `<harness>@<hostname>`, and default port is **8790** (channel mode keeps 8789). The allowlist file stays shared. *Why extend:* one optional path parameter on an existing module.
8. **Auto-allow own tools.** When an ACP permission request targets one of the daemon's injected hitl tools, the daemon answers `allow` itself (audited). The phone already gates those tools by trust tier (SPEC-HITL-CC-001), so asking again would double-prompt. All other permission requests go to the phone.
9. **Customization isolation (requirement; mechanism chosen at implementation).** Daemon-spawned harness sessions must not run user hooks that themselves ping HITL and block (the spike's stop-hook stall). Acceptable mechanisms: launch the child with a daemon-specific app-data dir/profile (`agy acp --app-data-dir`), or set a documented env var (e.g. `HITL_DAEMON_SESSION=1`) that the empire's HITL hooks check before firing. The chosen mechanism must be documented in README and verified by AV11.
10. **Pairing code delivery in daemon mode.** The 6-digit code is written to stdout and the daemon log, and raises a macOS/Linux desktop notification when available. Pairing endpoints and allowlist semantics are unchanged.

**Capability-already-exists check, app side.** The app already supports multiple hitl-channel instances per host via `ClaudeCodeConnectionPool` and mDNS discovery (`claude_code_discovery.dart` reads `instanceId`/`displayName` from TXT). The `choices` frame renders tappable options, and `choice_response` is posted back with the selected label as content. That is why Phase 1 needs no app change. **Known limitation:** `choice_response` does not carry the originating `choices` frame id, so the daemon correlates permissions FIFO per active session. Phase 3 adds the id.

### 4.3 UI/UX — TWO surfaces

#### 4.3a User UI/UX & Design System Adherence

- **Phase 1 has no hitl-app UI change.** The daemon appears in the app as another "Claude Code" instance named e.g. `agy@macbook` (display name from mDNS TXT). Pairing, chat bubbles, choices chips and local notifications are the existing widgets. No new Flutter widgets, so no design-system, adaptive-widget, theme or accessibility deltas in Phase 1. These are locked as "no app diff" by AV13.
- **Slash command UX (rendered as ordinary reply bubbles, plain text/markdown):**
  - `/help`: lists the commands.
  - `/new [harness] [cwd]`: creates the session and switches the active session. Replies "▶ New agy session in `<cwd>` (id …)". `cwd` defaults to the daemon's configured default directory and must be an existing absolute path or `~`-relative. Otherwise an error reply.
  - `/sessions`: numbered list (title · cwd · relative time), max 10, with the active one marked.
  - `/resume <n|id>`: switches the active session, then replies "▶ Resumed …".
  - `/cancel`: sends `session/cancel` for the running turn. Replies "⏹ cancelled" once the turn ends with `cancelled`.
  - `/status`: harness, active session, turn running?, queue depth, pending approvals.
- **States:**
  - *No session yet:* the first plain message auto-creates a session in the default cwd and says so.
  - *Busy:* "⏳ queued (n ahead)".
  - *Harness crashed:* an error reply naming the harness and exit code, followed by an automatic restart and an "/resume to continue" hint.
  - *Pending approval:* the choices card. Plain chat messages while an approval is pending get the reply "⚠ waiting for your approval above".
- **Permission card content:** the prompt is the tool title plus a compact one-line summary of `rawInput`, truncated to 300 chars. Choices are the ACP option names (e.g. "Allow", "Deny").

#### 4.3b Agent UI/UX (the agent-facing surface — equal weight)

- **Invocation:** daemon-mode agents see the canonical tool names `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_devices`. The harness namespaces them, e.g. agy shows `mcp_hitl-channel_call_phone_tool`. The MCP server name injected must be `hitl-channel`, so the namespaced names match what Claude Code shows today.
- **Discoverability:** (a) tool descriptions are the existing ones, unchanged (shared module); (b) standing orders arrive through the system-prompt append (agy) and tell the agent to default to `call_phone_tool` for phone actions and to use `list_phone_tools` for the live catalog.
- **Authoring/configuration:** an agent that wants to create a *local agent on the phone* does so through `call_phone_tool("create_local_agent", …)`, which is the existing phone tool surface. Nothing new.
- **Parity statement:** *agent → phone* parity with Claude Code channel mode is full, except for `reply_to_hitl`. That tool is deliberately withheld because the end-of-turn reply replaces it (§4.2 item 5), and withholding it prevents premature delegation resolution. *Session control* (`/new`, `/resume`) is user-only in Phase 1. Deliberate reason: it would let one session spawn and steer sessions recursively. Revisit when there's a use case.

### 4.4 DRY & KISS Principles

- **One phone-facing half.** Pairing, allowlist, mDNS, WS/ACK, reply buffer, correlator and audit are shared, never forked per mode. A behaviour fix in the bridge lands for both modes at once.
- **One tool module.** Tool schemas and handlers exist once and are registered onto whichever MCP server a mode runs. The snapshot tests that pin tool descriptions and instructions keep covering both modes.
- **Map onto existing frames before inventing new ones.** Phase 1 adds **zero new WS frame types**. Permissions reuse `choices`. Session control reuses `reply`. New frames (session list, streaming partials, permission ids) wait until Phase 3, where the app actually renders them.
- **One function seam, not a transport hierarchy.** The bridge takes `deliverInbound(content, meta)`. The session manager is the only new stateful component.
- **No relay dependency.** Daemon mode makes no outbound network calls other than the harness's own.

## 5. Delivery Plan

### Phase 1: MV — agy daemon mode, zero app change
- **Scope:** §4.2 items 1–5 and 7–10 for harness `agy`, and the slash commands in §4.3a. README section "Daemon mode", plus a launchd plist example.
- **CEO Outcome:** from the phone, the CEO can start, list, resume and chat with Antigravity sessions on any paired machine, approve actions with a tap, and let those agents drive the phone. No relay, and no app release needed.

### Phase 2: Hermes + Codex
- **Scope:** add the `hermes` and `codex` (codex-acp adapter) registry rows after wire-verifying each one with the same spike script. Add the stdio MCP shim if either rejects HTTP MCP. Allow multiple harnesses per daemon (`/new hermes …`), or one daemon per harness. That choice is made at the start of Phase 2, based on what the spike shows about process isolation.
- **CEO Outcome:** the same phone control over Hermes and Codex sessions. "HITL works with any agent harness" becomes true and demonstrable.

### Phase 3: hitl-app native host-agent UX
- **Scope:** generalise `AgentType.claudeCode` into a host-agent type with a harness badge. Add a native session list and New-session sheet driven by new `session_list`/`session_switched` frames, streaming partials (`agent_message_chunk`, tool-call progress), and a `choices.id` carried on `choice_response`. Optionally mirror Claude Code into daemon mode via the claude-agent-acp adapter.
- **CEO Outcome:** session management feels native (no slash commands), with live progress while the agent works.

## 6. Regression Analysis & Testing Strategy

### 6.1 Regression Risks

| Risk | Mitigation |
|---|---|
| Extracting tools from `server.ts` changes channel-mode tool schemas/descriptions | existing `server-instructions.test.ts` snapshot plus a new snapshot of the channel-mode `tools/list` taken **before** the refactor (AV1) |
| `deliverInbound` seam changes pairing/POST/WS behaviour in channel mode | the existing `server.test.ts`, `pairing-integration.test.ts`, `multi_device.test.ts`, `questions_batch_ws.test.ts` suites stay green unmodified (AV13) |
| Daemon and CC channel on the same host collide on port/instanceId | separate identity file and port 8790 by default (AV2) |
| Loopback MCP endpoint exposed beyond localhost | bind `127.0.0.1` only, plus a per-process random bearer token in the injected `headers` (AV12) |
| Orphaned harness children on daemon exit | the shutdown handler kills the child process group (AV10) |
| User hooks stall daemon sessions | customization isolation (§4.2 item 9, AV11) |
| Early `reply` resolves a workflow delegation prematurely | `reply_to_hitl` not registered in daemon mode, and exactly one end-of-turn reply (AV5, AV9) |

### 6.2 Testing Strategy

- **Unit (bun test):** the session manager against a **fake ACP agent** (an in-process ndjson peer that scripts `session/update` chunks, `request_permission` and stopReasons). Covers slash-command parsing, queueing, cancel, permission correlation and delegation envelope tagging.
- **Integration (bun test):** daemon boot with the fake agent as a child process. Full phone flow over real HTTP/WS: pair → POST → reply frame; tool bridge via the HTTP MCP endpoint → `tool_call_request` frame → `tool_call_result` → MCP result.
- **Wire smoke (manual/scripted, not CI):** the spike scripts promoted to `scripts/acp_smoke.py`, run against the real `agy acp` on the dev box.
- **E2E (CV):** a real phone against a real daemon on Tailscale.

## 7. Acceptance Criteria

### Agent-verifiable
- [ ] **AV1** Channel mode's `tools/list` output (names, descriptions, schemas) and `initialize` instructions are byte-identical before and after the tool-module extraction. This is pinned by a snapshot captured on the pre-refactor commit.
- [ ] **AV2** `hitl-channel daemon --harness agy` listens on 8790 by default, persists its identity at `~/.hitl/channels/identity-daemon-agy.json` with a distinct `instanceId` from `identity.json`, advertises `_hitl-channel._tcp` with displayName `agy@<hostname>`, and on `/pair/request` prints the 6-digit code to stdout. `/pair/validate` with that code returns a device token that authorises `POST /` and `/ws`.
- [ ] **AV3** With the fake ACP agent: a plain POST `/` message (and a WS chat frame) results in exactly one `session/prompt` to the active session, with the text content (and formatted `questions_batch_response` text) unchanged from what channel mode would have delivered.
- [ ] **AV4** An image attachment on an inbound message is passed to `session/prompt` as an ACP image content block. A non-image file attachment is saved by the existing `processAttachments` path, and its path appears in the prompt text.
- [ ] **AV5** For a turn whose fake agent emits chunks "a", "b", "c" then `stopReason: end_turn`, exactly one `reply` frame with text "abc" is broadcast, and it goes through the reply buffer / ACK protocol (verified by reconnect-drain replay).
- [ ] **AV6** In daemon mode, an MCP `tools/call call_phone_tool` arriving on the loopback HTTP endpoint produces a `tool_call_request` WS frame. The matching `tool_call_result` frame resolves the MCP call with the phone's output. The audit line records the ACP session id from `_meta["antigravity.google/conversation_id"]` when present.
- [ ] **AV7** The daemon's injected MCP server exposes exactly `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl` and `list_devices` (no `reply_to_hitl`), with descriptions identical to channel mode's.
- [ ] **AV8** A fake-agent `session/request_permission` for a non-hitl tool produces one `choices` frame whose choices are the option names. A following `choice_response` "Allow" sends exactly one outcome `{outcome:"selected", optionId:"allow"}`. A second tap afterwards gets a "no pending approval" reply and sends no second outcome. A permission request targeting an injected hitl tool is answered `allow` by the daemon without any phone frame, and is audited.
- [ ] **AV9** An inbound message wrapped in `<workflow_delegation message_id="X">` yields exactly one `reply` frame with `message_id: "X"` at end of turn. A non-delegation message's reply has no `message_id` equal to any pending delegation id.
- [ ] **AV10** Slash commands: `/new <cwd>` sends `session/new` with that cwd, the `hitl-channel` HTTP MCP server, and `_meta.antigravity.systemPrompt.append` = `DAEMON_INSTRUCTIONS`; `/sessions` renders `session/list` results (max 10, active marked); `/resume <n>` calls `session/load` or `resume` and switches active; `/cancel` sends `session/cancel` and the turn ends as cancelled; a message sent mid-turn is queued and dispatched after the turn ends, in FIFO order; an invalid cwd gets an error reply and no ACP call. On SIGTERM, the harness child process is gone within 5 s.
- [ ] **AV11** Daemon-spawned harness sessions run with the documented customization-isolation mechanism. A test asserts the child is launched with that profile/env.
- [ ] **AV12** The loopback MCP endpoint binds `127.0.0.1` only and rejects requests without the per-process bearer token (401). The daemon makes no network connection to any `hitlrelay.app` host. Asserted by code review of the outbound call sites plus a test that a missing relay config does not affect daemon operation.
- [ ] **AV13** All pre-existing test files pass unmodified in channel mode, and no file under `hitl-app` changes in Phase 1.

### CEO device-verify (work-with-CEO on device)
- [ ] **CV1** On a real phone over Tailscale: discover or enter `agy@<host>:8790`, pair with the code printed on the host, send "hello", and receive the agent's reply bubble plus a local notification when the app is backgrounded.
- [ ] **CV2** From the phone: `/new ~/lab/hitl` → ask "what repo am I in?" → the answer references hitl. `/sessions` lists it with an auto title, and `/resume` on an older session continues it.
- [ ] **CV3** From the phone, ask the agy agent to "list my phone tools and create a test local agent on my phone". The phone's trust-tier sheet appears for the create, and after you approve, the agent exists in the app.
- [ ] **CV4** Ask the agent to run a shell command that requires permission. An Allow/Deny card appears on the phone. Deny → the agent reports it was denied. Allow (on retry) → the command runs.
- [ ] **CV5** With the relay unreachable (e.g. relay host blocked on the Mac), CV1 and CV2 still pass.

### Two checks on the finished list
1. **Set read for contradictions.** AV5 (exactly one reply per turn) vs. AV10 (queued-message acknowledgement replies): the "queued" acknowledgement is a separate reply for a *different* inbound message, not a second reply for the running turn. Consistent. AV7 (no `reply_to_hitl`) vs. AV9 (delegation reply exists): the delegation reply is daemon-produced, not tool-produced. Consistent. AV8 (auto-allow own tools) vs. CV3 (phone sheet appears): the phone's trust-tier sheet is the phone's own gate and is independent of the ACP permission. Consistent.
2. **Generated-string proxies.** AV1 and AV7 assert generated tool-list text. They are deliberate contract snapshots, and the behaviour behind them is covered by AV6 and CV3. AV11 asserts launch arguments/env only; the behaviour (no hook stall) is observed during CV1/CV2.

## 7a. User-Story → AC Traceability

| User story phrase | AC # | Notes |
|---|---|---|
| "`/new agy ~/lab/hitl` … fresh Antigravity session starts in that folder" | AV10, CV2 | Phase 1 has one harness, so the `agy` argument is accepted, and other values get an error reply until Phase 2 |
| "next message goes to it" | AV3, AV10 | active session |
| "`/sessions` … title, folder, last activity" | AV10, CV2 | |
| "`/resume <n>` to switch" | AV10, CV2 | |
| "message sent mid-turn to queue" | AV10 | |
| "`/cancel` to stop the running turn" | AV10 | |
| "permission requests appear as tappable Allow / Deny" | AV8, CV4 | |
| "own LAN/Tailscale with the same pairing code flow … no third party" | AV2, AV12, CV1, CV5 | |
| "tools available in my tool list, plus standing orders" | AV7, AV10, CV3 | |
| "act on the phone as if I were running on it" | AV6, CV3 | |
| "`<workflow_delegation message_id=X>` resolves with the final answer" | AV9 | an on-device workflow CV is deferred to Phase 3 (needs the app to target a daemon instance from the workflow builder, which it already can as a Claude Code instance; optional CV during Phase 1) |
| "existing stdio/channel mode untouched" | AV1, AV13 | |

## 8. Out of Scope (Phase 1)

- Native app session UI, streaming partials, and harness badges (Phase 3).
- Hermes and Codex (Phase 2).
- Sessions started from the phone appearing live in the agy TUI. agy's own store may make them resumable from the CLI, but that is not required.
- Push notifications when the app is killed. Behaviour stays as today: local notifications while connected, and reply-buffer replay on reconnect.
- Agent-initiated session creation (see §4.3b parity statement).
- E2E encryption beyond the transport (unchanged from today; Tailscale/VPN recommended).
