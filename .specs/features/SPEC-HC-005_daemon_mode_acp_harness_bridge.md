---
id: SPEC-HC-005
title: "Daemon mode — hitl-channel as an ACP client so the phone can drive any harness (agy first)"
status: "Draft"
owner: "hitl-channel"
created_by: "cos"
last_updated: 2026-11-21
products: ["hitl-channel", "hitl-cli"]
depends_on: ["SPEC-HC-001", "SPEC-HC-002", "SPEC-HC-003", "SPEC-HC-004", "SPEC-HITL-CC-001"]
---

# Daemon mode — hitl-channel as an ACP client so the phone can drive any harness (agy first)

> **Provenance.** Brainstormed with the CEO via HITL MCP on 2026-11-21. The brief, committed alongside this spec, is `.specs/_pending/BRAINSTORM-hitl-channel-daemon-acp.md`. An `agy acp` spike the same day passed every protocol check this spec relies on (§4.1 "Verified protocol facts"). Revision 2 folds in two independent empire-spec-reviews from the same day (Gemini 4 Neon and Gemini 4 Carbon).
>
> **Sibling positioning.**
> - **SPEC-HC-001 / 002 / 003** (pairing, mDNS, channel messaging): *extended*. The phone-facing side is reused. One seam changes (§4.2 item 1).
> - **SPEC-HC-004** (questions batch): *disjoint*. Still available to daemon agents through the injected tool set.
> - **SPEC-HITL-CC-001** (CC companion agent: phone tool bridge, workflow delegation, Phase 6 reply attachments): *extended*. Daemon mode brings all three to non-Claude harnesses.
> - **Name collision:** in `hitl-shin-relay`, "ACP" means *Awesome ChatGPT Prompts* (SPEC-AW-278). Here ACP always means the **Agent Client Protocol** (agentclientprotocol.com).

## 1. Executive Summary

Today the phone can only push into, and receive from, a **Claude Code** session. Claude Code's research-preview `notifications/claude/channel` capability is hitl-channel's only inbound path, and Claude Code itself spawns hitl-channel as a stdio MCP child. The other harnesses the CEO uses (Antigravity `agy`, Hermes, Codex) can only reach the phone through the relay-based HITL MCP, which talks one way, long-polls for ~15 minutes, cannot start a new session and cannot inject a message into a running one. This spec adds a **daemon mode**, `hitl-channel daemon --harness agy`: a long-lived process that **spawns the harness's ACP server and acts as its ACP client**, while the phone-facing HTTP/WS surface stays the same (pairing, allowlist, mDNS, reply buffer, ACK protocol, correlator). Phone messages become ACP `session/prompt`, and the agent's turn text comes back as the existing `reply` frame. ACP permission requests become the existing `choices` frame. The phone tool bridge (`call_phone_tool`, `list_phone_tools`, `push_file`, `reply_to_hitl` attachments and the rest) is injected into every ACP session as a loopback MCP server, so a remote agent can drive the phone exactly as Claude Code does today. Sessions are created, listed and resumed from the phone with chat slash commands. Phase 1 needs **no hitl-app change and no relay**, which keeps the path relay-free for privacy-conscious users.

## 2. CEO Business Outcomes

- [ ] **From the phone, the CEO can start a brand-new Antigravity session in a chosen folder on a chosen machine and talk to it, without touching the keyboard.** This closes today's gap, where only Claude Code is reachable and only after a terminal session already exists. *(Verified by CV1, CV2.)*
- [ ] **A remote Antigravity agent controls the phone the same way a Claude Code agent can.** It can list and call phone tools, push files, send images, and present choices. That unlocks desktop agents building local agents on the phone, troubleshooting the app, and running the dev loop. *(Verified by AV6, AV7, CV3.)*
- [ ] **The CEO approves or denies an agent's risky actions with one tap on the phone**, instead of the session stalling silently on a desktop prompt nobody is watching. *(Verified by AV8, CV4.)*
- [ ] **Messages never pass through a cloud intermediary.** Phone ↔ machine traffic stays on LAN, Tailscale or the user's own VPN, as with CC channels today, and daemon sessions don't wake the relay-based HITL stop hook. *(Verified by AV11, AV12, CV5.)*
- [ ] **Existing Claude Code channel users see zero change.** The current `.mcp.json` setup, pairing and chat keep working exactly as before. *(Verified by AV1, AV13.)*

## 3. User Stories

- As **the CEO on my phone**, I want to type `/new ~/lab/hitl` in a paired machine's chat, so that a fresh Antigravity session starts in that folder and my next message goes to it.
- As **the CEO**, I want `/sessions` to list my most recent agy sessions (title, folder, last activity) and `/resume <n>` to switch to one, so that I can pick up work the agent (or I) started earlier.
- As **the CEO**, I want a message sent mid-turn to be queued, and `/cancel` to stop the running turn, so that typing while the agent is busy doesn't corrupt or lose work.
- As **the CEO**, I want the agent's permission requests to show up in the chat as tappable Allow / Deny choices, even if my app was backgrounded when the request came in, so that sessions don't stall.
- As **a privacy-conscious user**, I want daemon mode to work over my own LAN/Tailscale with the same pairing-code flow, so that no third party sees my traffic.
- As **an Antigravity agent running under the daemon**, I want `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_devices` and `reply_to_hitl` (for attachments and interim updates) in my tool list, plus standing orders explaining them, so that I can act on the phone as if I were running on it.
- As **a hitl-app workflow step delegating to a host agent** (`ClaudeCodeAgentRunner`), I want the `<workflow_delegation message_id=X>` contract to resolve with the agent's final answer, so that workflows that delegate to "Claude Code" today also work against a daemon-backed agy instance.
- As **a Claude Code channel user**, I want the existing stdio/channel mode left untouched, so that nothing I rely on regresses.

**Sibling-primitive audit.** The surface is *inbound delivery from the phone into the agent* plus *agent → phone frames*. Every primitive that flows through it:

| Primitive (phone → hitl-channel) | Call site today | Daemon-mode verdict |
|---|---|---|
| Chat message via `POST /` | POST handler → `processAttachments` → `sendChannelNotification` | → `onInbound({text, attachments, meta})` → `session/prompt` on the active session (AV3) |
| Chat message via WS frame (no `type`) | WS `message` handler (separate, unnormalised path) | → shares POST's metadata normaliser, then follows the same path (AV3) |
| `choice_response` | POST `/` (content = label, `selections`) | resolves a pending ACP permission if one exists. Otherwise forwarded as a prompt **iff** a `present_choices_to_hitl` card is still open. Otherwise answered with "no pending approval" (AV8) |
| `questions_batch_response` | POST `/`, formatted answers | forwarded as a prompt using the existing formatter (AV3) |
| Pairing request (`/pair/request`, **unauthenticated**) | `sendChannelNotification` | → `onPairingCode(code)`. **Never** reaches the session manager (AV2) |
| Attachments | `processAttachments` writes all of them to the inbox | images → ACP image content blocks from the raw base64 + MIME. Non-image files → existing inbox path cited in the text (AV4) |
| `tool_call_result` / `list_tools_result` / `questions_batch_result` / `ack` | WS `type`-first routing → correlator | **unchanged** (AV6) |

| Primitive (agent → phone) | Daemon-mode verdict |
|---|---|
| Final `reply` frame | produced by the daemon at end of turn from the collected `agent_message_chunk`s (AV5) |
| `reply_to_hitl` (text and/or attachments, CC-001 Phase 6) | **kept**, for interim updates and inline image/file attachments. In daemon mode its `message_id` is always stripped, so it can never resolve a workflow delegation (AV7, AV9) |
| `choices` frame | from `present_choices_to_hitl` (tool) **and** from ACP `session/request_permission` (AV8) |
| `questions_batch_request`, `tool_call_request`, `list_tools_request`, file push | via the injected MCP tools, same handlers (AV6, AV7) |
| Out-of-turn agent output (agy wakes an idle session for background tasks/subagents) | sent as standalone replies, never merged into the next prompt's reply (AV5) |

## 4. Technical Implementation & Architecture

### 4.0 Target State — the end-state picture in one read

hitl-channel has **one phone-facing half and two interchangeable agent-facing halves**. The phone-facing half is everything the app already knows: the HTTP endpoints, the WebSocket with its ACK protocol and reply buffer, pairing, the hashed-token allowlist, mDNS advertisement, the frame correlator and the audit log. It hands inbound traffic to whichever agent-facing half is running, through two narrow callbacks: one for user input (text, attachments, metadata) and one for pairing codes. It does not know which agent is behind them.

The first agent-facing half is today's **channel mode**. Claude Code spawns hitl-channel over stdio. User input becomes a `notifications/claude/channel` notification, pairing codes are announced in the Claude Code session, and the agent answers with the `reply_to_hitl` tool. Nothing about it changes.

The second agent-facing half is **daemon mode**. The user (or launchd/systemd) starts hitl-channel as a long-lived process naming a harness. The daemon has its own identity and port, so it shows up in the app as a separate instance from any Claude Code channel on the same machine. It spawns the harness's ACP server as a child in its own process group and drives it as the ACP client.

It owns a small **session manager** holding:
- the set of ACP sessions it has created or resumed, and which one is *active* for chat;
- a FIFO of messages waiting for the current turn;
- permission requests waiting on a phone tap;
- a count of open user choice cards.

A **harness registry** maps a harness name to the command that starts its ACP server and to per-harness tweaks. agy comes first; Hermes and Codex follow.

The **phone tool bridge is a shared tool module** that neither half owns. In channel mode it is served over Claude Code's stdio MCP connection. In daemon mode the same tool definitions and handlers are served over stateless MCP Streamable HTTP on a loopback-only, bearer-protected endpoint. That endpoint is injected into every ACP session the daemon creates or resumes, and the daemon's standing orders are appended to the agent's system prompt. Every tool call carries the ACP session id, so the daemon and the audit log know which session is driving the phone.

**Session control is a conversation, not a new protocol.** In Phase 1 the daemon intercepts a handful of slash commands in chat and answers them as ordinary replies. A later phase gives the app native session UI on top of the same session manager.

**Everything stays direct and relay-free.** Notifications are still raised locally by the app from WS frames. Daemon-spawned sessions are marked so that the relay-based HITL stop hook stays silent, and the agent is told to talk to the user through its own turn output, not through relay tools.

### 4.1 Architecture

```
hitl-app (phone)               hitl-channel daemon (Bun, long-lived)                    agy acp (child, own pgid)
  │  POST / , WS /ws ─────────▶ phone-facing half ──onInbound──▶ SessionManager ──session/prompt─▶│
  │  POST /pair/request ──────▶                   ──onPairingCode──▶ stdout/log/desktop notif     │
  │◀── reply frame ───────────┤◀─────── end-of-turn / out-of-turn ◀── session/update chunks ─────┤
  │◀── choices frame ─────────┤◀─────── pending permission ◀──────── session/request_permission ─┤
  │── choice_response ────────▶──────── {outcome:{outcome:"selected",optionId}} ─────────────────▶│
  │◀─ tool_call_request ──────┤◀── shared tool module ◀── stateless MCP HTTP (127.0.0.1, bearer) ◀┤ call_phone_tool
  │── tool_call_result ───────▶──── correlator ──────────▶ MCP result ─────────────────────────────▶│
```

**Inbound routing in the session manager (normative order, evaluated per inbound message):**
1. **Pairing is never here.** Pairing codes come in only through `onPairingCode` and cannot trigger any ACP call.
2. **Slash command?** Recognised commands (§4.3a) are handled by the session manager and answered with **one** `reply` frame. Nothing is sent to the agent.
3. **Permission pending on the active session?**
   - If the message is a `choice_response`, or its trimmed text equals an option name (case-insensitive), it resolves the **oldest** pending permission with `{outcome:{outcome:"selected", optionId}}`. Exactly one outcome is sent per `request_permission` id.
   - Any other message, including workflow delegations, is **queued FIFO**, and the daemon replies "⚠ waiting for your approval above (queued)".
4. **`choice_response` with no pending permission?** If at least one `present_choices_to_hitl` card is still open, the open-card count is decremented and the message is forwarded as a prompt (step 6). Otherwise the daemon replies "no pending approval" and nothing reaches the agent. The open-card count resets to 0 when a plain (non-choice) prompt starts a turn, and whenever the active session changes (`/new`, `/resume`, auto-create). That way a stale card from earlier can't turn a late permission tap into a prompt.
5. **Turn running?** The message is queued FIFO, and the daemon replies "⏳ queued (n ahead)".
6. **Otherwise it becomes a prompt.** The daemon sends `session/prompt`; if no session exists yet, it first auto-creates one in the default cwd and says so. It collects `agent_message_chunk` text. When the prompt's response (`stopReason`) arrives, it calls the existing `broadcastReply()` **exactly once** with the collected text, then dequeues the next message. If the inbound content was wrapped in `<workflow_delegation message_id="X">…</workflow_delegation>`, that end-of-turn reply carries `message_id = X`. Otherwise it carries the phone's `client_message_id` (from `body.id`) when one is present. A turn that produced no text yields the reply "(no text output — stopReason: …)", but only when the turn was a workflow delegation, `stopReason` is not `end_turn`, or the agent did not call `reply_to_hitl` during the turn. Delegations therefore always resolve, and an attachment-only reply doesn't get a spurious bubble under it.

**Permission and connectivity lifecycle.**
- **Replay on reconnect.** Permission `choices` frames are unicast, as today. The daemon stores each pending permission's original `choices` frame, including its generated `id`, and re-sends that **exact frame** (same `id`) on every WS `open` via `onClientOpen`. The re-send is safe: the app's chat history deduplicates incoming frames by `id` (`ClaudeCodeHistoryRepository.addMessage` skips a row whose `messageId` already exists), so a re-sent card does not appear twice.
- **Cancellation.** `/cancel`, harness exit and daemon shutdown resolve every pending permission with `{outcome:{outcome:"cancelled"}}` before anything else happens.
- **Late taps.** A tap that arrives after its permission was already resolved gets the reply "no pending approval".

**Out-of-turn output.** agy can wake an idle session after `session/prompt` has returned, for example when background tasks or subagents finish. Chunks arriving while no turn is running go into a separate out-of-turn buffer, which is flushed as a standalone `reply` after 3 s of quiet or at the next `session/prompt` boundary, whichever comes first. They are never merged into a user prompt's reply.

**Protocol invariants honoured.**
- One end-of-turn `reply` per prompt turn.
- One permission outcome per `request_permission` id.
- One MCP result per `tools/call` id; the correlator already enforces this.
- One terminal state per turn: `end_turn`, `cancelled`, `max_tokens` or `refusal`, or an error surfaced as a reply.
- `reply_to_hitl` in daemon mode never carries a `message_id`, so the end-of-turn reply is the only frame that can satisfy a delegation.

**Verified protocol facts.** Every row below was observed on the wire or in the shipped CLI, not taken from docs. Sources: spike with agy acp 1.5.11 (2026-11-21); independent reviewers' checks against agy 1.5.14, agy logs and `agy changelog`.

| Fact | Observed |
|---|---|
| `initialize` capabilities | `loadSession: true`; `sessionCapabilities` = `resume`, `close`, `load`, `list`, `additionalDirectories`; `promptCapabilities.image: true`; **no `mcpCapabilities` advertised** |
| stdio MCP in `session/new.mcpServers` | agent called the injected tool and returned its secret token |
| **HTTP** MCP (`{type:"http", name, url, headers:[{name,value}]}`) | works even though not advertised. agy first POSTs a pre-initialize `server/discover`, then probes `GET /.well-known/oauth-protected-resource[/mcp]` and proceeds on 404/405 |
| MCP client per session | agy opens a **separate** MCP client for each ACP session (`session/new`, `session/resume`) |
| Session attribution | every MCP `tools/call` carries `_meta["antigravity.google/conversation_id"]` = ACP `sessionId` |
| Injected tool naming | agy namespaces MCP tools as `mcp_<server>_<tool>` (spike: `mcp_hitlspike_spike_ping`). The spike's **captured `session/request_permission` wire payload** carried `toolCall: {toolCallId, name:"mcp_hitlspike_spike_ping", title:"Run mcp_hitlspike_spike_ping", kind:"other", rawInput, status:"pending", …}`. Note that `toolCall.name` is an **agy extension**: ACP v1's `ToolCallUpdate` has no `name` field, while `toolCallId`, `title`, `kind` and `rawInput` are standard |
| System-prompt injection | `session/new._meta.antigravity.systemPrompt.append` is honoured |
| Permission request | `session/request_permission` options `{optionId:"allow",kind:"allow_once"}`, `{optionId:"deny",kind:"reject_once"}`, **including for injected MCP tools**. The response shape is `{outcome:{outcome:"selected",optionId}}` |
| `session/list` | returns all agy sessions in the app-data dir (432 on the dev Mac), with `title`, `cwd`, `updatedAt` |
| `session/resume` vs `load` | `resume` restores without history replay; `load` replays history as `session/update` |
| `cwd` | must be absolute; agy rejects a literal `~/…` |
| Updates | `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `session_info_update` (auto title), `usage_update`, `available_commands_update`, plus **out-of-turn** updates when background work wakes a session (changelog 1.5.12–1.5.14) |
| User customizations | `agy acp` loads the user's plugins from `--gemini-dir` (`~/.gemini/config/plugins`). The `hitl-cli` plugin's **Stop hook** (`review_and_continue_wrapper.sh`, 900 s timeout, contacts hitlrelay.app) fired inside the spike sessions and blocked each turn until the CEO answered. `--app-data-dir` does **not** isolate it, and would also hide existing sessions from `session/list` |

Classification of the non-agy harnesses is **TENTATIVE until Phase 2 verifies it on the wire**. Hermes (`hermes acp`) and Codex (via the Zed `codex-acp` adapter) are expected to fit the same mapping. Codex's HTTP-MCP support is unknown; the stdio fallback is §4.2 item 6.

### 4.2 Components

Extension-sites checklist results. Each item says why an existing component can or cannot own the change.

1. **Inbound seam (extend `http_bridge.ts`; no new transport class).**
   - **Signature.** `startHttpBridge(target: Server | InboundHandlers, opts?: { port?: number })`. Existing callers that pass an MCP `Server` keep today's behaviour exactly: the bridge wraps the server in default handlers that call `processAttachments` and then `sendChannelNotification`. Four existing test files call `startHttpBridge(mcpMock)` and must pass unmodified.
   - **`InboundHandlers`** is:
     ```
     {
       onInbound(input: { text, attachments?: HitlAttachment[], meta }): Promise<{ acpSessionId?: string | null } | void>,
       onPairingCode(code: string): void,
       onClientOpen?(send: (frame: Record<string, unknown>) => boolean): void,
     }
     ```
   - **`onInbound`** receives the **raw** attachments before `processAttachments` runs, so daemon mode can build ACP image blocks from the original base64 + MIME. It returns the ACP session id the message was routed to. On both the POST `/` and WS chat paths, the bridge **awaits** `onInbound` before writing its existing inbound audit line, and copies `acpSessionId` into it. This keeps one audit line per inbound message, with the session id attached.
   - **`onClientOpen`** is invoked synchronously inside the WS `open` handler, right after the reply-buffer drain, with a sender bound to that socket. It sends through the bridge's existing accepted-send path. The session manager uses it to re-send pending permission cards (§4.1).
   - **Shared normaliser.** POST `/`'s metadata normalisation (the flat/nested shape and `questions_batch_response` formatting) is extracted into a function that the WS chat path also uses. The phone's `body.id` is carried as `meta.client_message_id`.
   - **Port.** `opts.port` overrides the `HITL_CHANNEL_PORT ?? 8789` default.
   - **Response text.** In daemon mode the pairing-request response says the code is shown on the host, not "sent to Claude Code session".
   - *Why not a new transport class:* the bridge already owns the phone side. A union-typed first parameter is the smallest backward-compatible change.
2. **Shared tool module (`src/mcp_tools.ts`, extracted from `server.ts`).**
   - **What moves.** Tool definitions and the `CallToolRequest` dispatcher, for `reply_to_hitl`, `list_devices`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_phone_tools`, `call_phone_tool` and `push_file`.
   - **Interface.** It exposes `registerHitlTools(server, { mode: "channel" | "daemon", onChoicesPresented? })`.
   - **Channel mode stays as-is.** `server.ts` registers everything exactly as today, and keeps re-exporting `mcp`, `resolveAttachments`, `attachmentRoots`, `isPathAllowed` and `kMaxFileReadBytes`, which existing tests import.
   - *Why extract:* `server.ts` runs a top-level `await mcp.connect(new StdioServerTransport())` on import (the same reason `mcp_instructions.ts` was split out earlier), so daemon mode cannot import it.
3. **Daemon entry point (`src/daemon.ts`, new) and CLI (`src/cli.ts`, new).**
   - **CLI.** `package.json` gains `"bin": { "hitl-channel": "./src/cli.ts" }`. `cli.ts` routes `daemon …` to `daemon.ts` and `mcp-shim …` to the shim (item 6). With no subcommand, it imports `server.ts`, so it behaves exactly like `bun src/server.ts` and existing `.mcp.json` entries keep working. `bun run src/daemon.ts --harness agy` is also valid.
   - **Startup.** `daemon.ts` parses `--harness`, `--port` (default 8790; tests use an ephemeral port because `server.test.ts` already binds 8790) and `--name`. It then sets `HITL_CHANNEL_IDENTITY_FILE`, `HITL_CHANNEL_NAME` and `HITL_INSTANCE_ID` before loading identity or starting the bridge (item 7). It starts the bridge with the session manager's `InboundHandlers`, starts mDNS (expected to fix issue #3 as a side effect), and reuses the existing graceful-shutdown pattern.
   - **Loopback MCP endpoint.** The endpoint runs on `Bun.serve({ hostname: "127.0.0.1", port: 0 })` using the SDK's **`WebStandardStreamableHTTPServerTransport` in stateless mode**. Each `POST /mcp` request gets a fresh `(Server, transport)` pair with `sessionIdGenerator: undefined` and `enableJsonResponse: true`. This is required because agy opens a separate MCP client per ACP session, and one SDK `Server`/transport pair cannot serve multiple initializations.
   - **Auth on that endpoint.** `/mcp` requires `Authorization: Bearer <per-process random token>` and returns 401 otherwise. `GET /.well-known/*` returns 404 with **no** auth, so agy's OAuth probe proceeds. A pre-initialize `server/discover` must get a JSON-RPC response (result or `-32601`), not an HTTP 4xx.
   - *Why new:* `daemon.ts` has an orthogonal lifecycle. Channel mode dies with Claude Code's stdin; the daemon must not. `cli.ts` is a thin `bin` router, so subcommand dispatch never imports `server.ts` and never triggers its top-level stdio connect.
4. **ACP client + session manager (`src/acp_session_manager.ts`, new).**
   - **Spawning.** Spawns the harness child with `detached: true` (its own process group) and env `HITL_DAEMON_SESSION=1` (item 9), then calls `initialize`.
   - **New sessions.** `session/new` takes `{ cwd: <absolute; leading ~ expanded via homedir()>, mcpServers: [hitlHttp], _meta: { antigravity: { systemPrompt: { append: DAEMON_INSTRUCTIONS } } } }`, where `hitlHttp = {type:"http", name:"hitl-channel", url, headers:[{name:"Authorization", value:"Bearer …"}]}`.
   - **Resume.** It prefers `session/resume` when advertised, passing the same `cwd` (from `session/list`), `mcpServers` and `_meta`, so a resumed session always points at the *current* port and token. If it has to fall back to `session/load`, every `session/update` emitted while the load call is in flight is ignored.
   - **Other ACP calls.** `session/list`, `session/prompt` and `session/cancel`, plus the client side of `session/request_permission`.
   - **State.** `{activeSessionId, runningTurn, queue[], pendingPermissions[], openUserChoices, outOfTurnBuffer, lastListing}`.
   - **Harness crash.** If the child exits, pending permissions are cancelled, the phone gets an error reply naming the exit code, and the child is restarted once. Repeated crashes within 60 s stop the restarts and say so.
   - **Implementation choice.** The ACP TypeScript SDK and a minimal ndjson JSON-RPC client are both acceptable; pin the version. *Why new:* nothing in the repo speaks ACP. The grep, run on 2026-11-21:
     ```
     $ grep -rniE "acp|daemon|session/(new|prompt)|spawn\(" src --include='*.ts' | grep -v __tests__
     src/reply_buffer.ts:9:  * - In-memory only — daemon restart clears the buffer ...   (comment only)
     src/reply_buffer.ts:13: *   two daemons (or two test fixtures) never share state.     (comment only)
     ```
5. **Standing orders (extend `mcp_instructions.ts`).**
   - **Split.** `STANDING_ORDERS` is split into a shared `PHONE_TOOL_STANDING_ORDERS` core (inbound messages are the phone user; use `call_phone_tool` / `list_phone_tools`; trust tiers are gated on the phone) and the channel-only lines (`reply_to_hitl` with the inbound `message_id`; the Claude Code version requirement). `STANDING_ORDERS` and `MCP_INSTRUCTIONS` stay **byte-identical**, and the existing snapshot test pins this.
   - **New export.** `DAEMON_INSTRUCTIONS` = `PHONE_TOOL_STANDING_ORDERS` + a daemon reply block that says:
     - your turn's text is delivered to the phone automatically, so don't repeat it through `reply_to_hitl`;
     - use `reply_to_hitl` only for interim progress or to send images/files;
     - for `<workflow_delegation>` envelopes, finish the work, then end the turn with the final answer;
     - do not use `human-in-the-loop` / relay tools to talk to this user, because this chat is the channel.
6. **Harness registry (a table inside the session manager).** `agy` → `agy acp`: HTTP MCP, `_meta.antigravity.systemPrompt.append`, auto-allow prefix `mcp_hitl-channel_`. Phase 2 adds `hermes` → `hermes acp` and `codex` → the codex-acp adapter, each marked `TBD-pending-wire-verify`. If a harness rejects HTTP MCP, the fallback is `hitl-channel mcp-shim --url … --token …`, a stdio↔loopback-HTTP proxy.
7. **Identity and port isolation (extend `identity.ts`).**
   - **Path.** The identity file path is resolved **on every load/save** from `HITL_CHANNEL_IDENTITY_FILE`, defaulting to today's `~/.hitl/channels/identity.json`. A module-level constant would freeze it at import time.
   - **Hostname.** `getHostname()` falls back to `os.hostname()` before `"unknown"`. Today macOS (no `/etc/hostname`, and `HOSTNAME` unset under launchd) would advertise `agy@unknown`.
   - **Daemon defaults.** Identity file `~/.hitl/channels/identity-daemon-<harness>.json`, display name `<harness>@<hostname>`, `HITL_INSTANCE_ID` set from it. As a result `GET /instance`, the tool handlers and the audit lines all report the daemon identity, never the CC channel's.
   - **Allowlist.** The allowlist file stays shared.
   - *Why extend:* one dynamic path lookup and one fallback on an existing module.
8. **Auto-allow own tools.** The phone already gates the daemon's own tools with its trust-tier sheet (SPEC-HITL-CC-001), so the daemon answers their permission requests with `allow` itself and audits the decision, rather than prompting twice. A request counts as one of the daemon's own tools when the harness's **identification rule** matches. All other permission requests go to the phone.
   - **agy rule:** `toolCall.name` (an agy extension, observed on the wire) starts with `mcp_hitl-channel_`, **or** `toolCall.title` (standard ACP) starts with `Run mcp_hitl-channel_`.
   - **Phase 2 harnesses:** if a harness sends neither field, the daemon correlates `toolCall.toolCallId` with the preceding `session/update` `tool_call` notification for that id.
   - **Fail closed:** if no rule matches, the request goes to the phone. Auto-allow never applies by default.
9. **Customization isolation: one mechanism, cross-repo.** The daemon sets `HITL_DAEMON_SESSION=1` in the harness child's environment.
   - **Python hook.** In **`hitl-cli`**, `hitl_cli/hooks/review_and_continue.py` `main()` exits early when the variable is `"1"`. Under Antigravity (`--antigravity` / `IS_ANTIGRAVITY=1`) it prints `{"decision":"allow","reason":""}`; under Claude Code it prints nothing and exits 0, matching the existing per-harness stdout contract.
   - **Other entry points.** `review_and_continue_antigravity.py` and `review_and_continue_wrapper.sh` get the same guard. The wrapper guard takes effect immediately on the dev Mac. The Python guard reaches the Nix-built `result/bin/hitl-hook-review-and-continue` only after a `nix build` in hitl-cli, and that rebuild is part of Phase 1.
   - **Why the Python entry point.** Putting the guard there means it holds for every install, not just one wrapper. **Phase 1 starts with a wire check:** does agy pass its process environment to hook subprocesses? `scripts/acp_smoke.py` asserts the hook's early exit is hit, via a marker the guard writes when `HITL_HOOK_DEBUG=1`. If agy turns out not to propagate the environment, implementation stops and goes back to the CEO; there is no silent fallback.
10. **Pairing code delivery.** `onPairingCode(code)` writes the 6-digit code to stdout and the daemon log, and raises a desktop notification (`osascript` on macOS, `notify-send` on Linux) when one is available. Pairing endpoints, expiry and allowlist semantics are unchanged.
11. **Audit (extend `audit.ts`).**
    - **New optional field.** `AuditEvent` gains `acp_session_id?: string | null`. Channel mode omits it, so its lines stay byte-compatible. Daemon mode fills it from `_meta["antigravity.google/conversation_id"]` on tool calls, and from the session manager for prompts and replies.
    - **New permission events.** The closed enums gain `AuditKind "permission"` and `AuditApproval "cancelled"`. Permission events use `direction: "harness_to_phone"` (new) with `approval` one of `auto`, `user_approved`, `user_denied` or `cancelled`.
    - **`tool_name` on permission events.** It holds the tool identifier (the agy `toolCall.name`, or the title-derived name), never `null`.
    - **Tests.** Tests for the new field and enum values go in a **new** file, `src/__tests__/daemon_audit.test.ts`. The existing `audit.test.ts` is not touched (AV13).

**Capability-already-exists check, app side** (grep run 2026-11-21):
```
$ grep -n "instanceId\|displayName" packages/hitl_agents/lib/src/services/claude_code_discovery.dart   → :63-66 (TXT → instance)
$ grep -n "class ClaudeCodeConnectionPool" -r packages/hitl_agents/lib                                → channels/claude_code_connection_pool.dart
$ grep -rn "'type': 'choice_response'" packages/                                                       → claude_code_chat_screen.dart:147, unified_chat_screen.dart (content = label, selections, no frame id)
$ grep -n "backgroundGracePeriod" packages/hitl_agents/lib/src/services/claude_code_service.dart      → Duration.zero (WS closes on background)
```
- The app already handles multiple hitl-channel instances via mDNS discovery and the connection pool, renders `choices` cards, ACKs them by `id`, and posts `choice_response` with the label as content. That is why Phase 1 needs no app change.
- **Known limitations, accepted for Phase 1:**
  - `choice_response` carries no frame id, so permissions are correlated FIFO with the open-card discriminator (§4.1 step 4). Phase 3 adds the id.
  - The app closes its WS as soon as it is backgrounded, so replies are seen and notified when the app returns to the foreground (reply-buffer drain), not while it is backgrounded. Phase 1 does not change this.

### 4.3 UI/UX — TWO surfaces

#### 4.3a User UI/UX & Design System Adherence

**No hitl-app UI change in Phase 1.** The daemon shows up as another "Claude Code" instance named e.g. `agy@Mac`, using the display name from mDNS TXT and `GET /instance`. Pairing, chat bubbles, choices chips and local notifications are the existing widgets. With no new Flutter widgets, Phase 1 has no design-system, adaptive-widget, theme or accessibility deltas; AV13 locks "no app diff".

**Slash commands.** Replies are ordinary bubbles in plain text/markdown.

| Command | Behaviour |
|---|---|
| `/help` | lists the commands |
| `/new [harness] [cwd]` | **Grammar:** a single argument starting with `/`, `~` or `.` is a cwd on the default harness. Any other single token is a harness name; in Phase 1 only `agy` is accepted, anything else gets an error reply. `cwd` defaults to the daemon's configured default directory, is `~`-expanded, and must be an existing directory, otherwise it gets an error reply and no ACP call is made. On success: creates the session, makes it active, replies "▶ New agy session in `<abs cwd>` (id …)". |
| `/sessions` | `session/list` sorted by `updatedAt` descending, top 10, numbered (title · cwd · relative time), active one marked. If the active session isn't in the top 10, it is appended as a marked extra line. The numbering is cached for `/resume`. |
| `/resume <n\|id>` | `<n>` resolves against the last `/sessions` listing. Resumes per §4.2 item 4, makes it active, replies "▶ Resumed `<title>`". |
| `/cancel` | resolves pending permissions as cancelled, sends `session/cancel`, replies "⏹ cancelled" when the turn ends. With no turn running, replies "nothing running". |
| `/status` | harness, active session (title/cwd), whether a turn is running, queue depth, pending approvals |

**States** (each locked by an AC):

| State | What the user sees |
|---|---|
| No session yet | the first plain message auto-creates a session in the default cwd and says so (AV10) |
| Busy | "⏳ queued (n ahead)" (AV10) |
| Approval pending | permission card. Other messages get "⚠ waiting for your approval above (queued)" and are queued (AV8) |
| Card missed while backgrounded | re-sent on reconnect (AV8) |
| Harness crashed | error reply with the exit code, one automatic restart, and a "/resume to continue" hint (AV10) |

**Permission card content.** Prompt = tool title + a one-line summary of `rawInput`, truncated to 300 characters. Choices = the ACP option names (e.g. "Allow", "Deny").

#### 4.3b Agent UI/UX (the agent-facing surface — equal weight)

- **Invocation.** Daemon-mode agents see the canonical tool names `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_devices` and `reply_to_hitl`, namespaced by the harness (agy: `mcp_hitl-channel_<tool>`). The injected MCP server name is `hitl-channel`.
- **Discoverability.**
  - Tool descriptions are the shared ones. The one exception is `reply_to_hitl` in daemon mode, whose description adds: "interim updates / attachments only; your turn text is delivered automatically; `message_id` is ignored".
  - Standing orders arrive through the system-prompt append and point the agent at `call_phone_tool` and the live `list_phone_tools` catalog.
- **Authoring/configuration.** An agent creates *local agents on the phone* through `call_phone_tool("create_local_agent", …)`, the existing phone tool surface.
- **Parity statement.** *Agent → phone* parity with Claude Code channel mode is **full**, including Phase 6 inline attachments through `reply_to_hitl`. The one deliberate difference is that daemon-mode `reply_to_hitl` cannot carry a `message_id`, because the end-of-turn reply owns delegation resolution. *Session control* (`/new`, `/resume`) is user-only in Phase 1: letting a session spawn and steer other sessions recursively needs its own safety design. Revisit when there's a use case.

### 4.4 DRY & KISS Principles

- **One phone-facing half.** Pairing, allowlist, mDNS, WS/ACK, reply buffer, correlator and audit are shared and never forked per mode. A bridge fix lands for both modes.
- **One tool module.** Tool schemas and handlers exist once and are registered onto whichever MCP server a mode runs. The only per-mode difference is the `reply_to_hitl` `message_id` strip and its description suffix.
- **One normaliser for inbound metadata.** POST and WS chat share it, which removes an existing divergence instead of copying it.
- **Map onto existing frames before inventing new ones.** Phase 1 adds **zero new WS frame types**. Permissions reuse `choices` and session control reuses `reply`. New frames wait for Phase 3, where the app renders them.
- **Stateless loopback MCP.** A fresh server per request means no MCP session table to manage and nothing to go stale after harness restarts.
- **No relay dependency.** Daemon mode makes no outbound network calls of its own. The hook guard and standing orders keep daemon sessions from reaching the relay.

## 5. Delivery Plan

### Phase 1: MV — agy daemon mode, zero app change
- **Scope:**
  - §4.2 items 1–5 and 7–11 for harness `agy`;
  - the §4.3a slash commands and states;
  - the `hitl-cli` hook guard (item 9);
  - README "Daemon mode" section with a launchd plist example;
  - `scripts/acp_smoke.py`, promoted from the spike.
  - **The first task** is the item 9 env-propagation wire check.
- **CEO Outcome:** from the phone, the CEO can start, list, resume and chat with Antigravity sessions on any paired machine, approve actions with a tap, and let those agents drive the phone. No relay and no app release needed.

### Phase 2: Hermes + Codex
- **Scope:** wire-verify `hermes acp` and the codex-acp adapter with `acp_smoke.py`, then add their registry rows. Add the stdio shim if either rejects HTTP MCP. Decide between one daemon per harness and multiple harnesses per daemon based on that evidence.
- **CEO Outcome:** the same phone control over Hermes and Codex sessions. "HITL works with any agent harness" becomes true and demonstrable.

### Phase 3: hitl-app native host-agent UX (separate child spec)
- **Scope:** to be specced as a dedicated `SPEC-HITL-APP-*` that follows the hitl-app design-system and adaptive-widget rules:
  - a host-agent type with a harness badge, replacing the hardcoded `AgentType.claudeCode`;
  - a native session list and New-session sheet, driven by new `session_list` / `session_switched` frames;
  - streaming partials and tool-call progress;
  - `choices.id` echoed on `choice_response`;
  - optionally, Claude Code through the claude-agent-acp adapter.
- **CEO Outcome:** session management feels native (no slash commands), with live progress while the agent works.

## 6. Regression Analysis & Testing Strategy

### 6.1 Regression Risks

| Risk | Mitigation |
|---|---|
| Tool extraction changes channel-mode tool schemas, descriptions or instructions | snapshot of channel-mode `tools/list` + `initialize` instructions captured on the pre-refactor commit (AV1); existing `server-instructions.test.ts` |
| Seam change breaks existing callers/tests (`startHttpBridge(mcpMock)` in 4 suites; `server.ts` re-exports used by 4 more) | `Server` overload preserved; re-exports kept; all existing test files pass unmodified (AV13) |
| Daemon and CC channel collide on port or `instanceId`, or the daemon advertises `agy@unknown` | dynamic identity path, `os.hostname()` fallback, port 8790 (AV2) |
| Daemon tests collide with `server.test.ts`'s fixed port 8790 | daemon integration tests use ephemeral ports (AV13) |
| Second ACP session fails to initialise MCP | stateless per-request MCP server (AV6) |
| Loopback MCP reachable beyond localhost, or OAuth probe mis-signalled | `127.0.0.1` bind, bearer on `/mcp`, unauthenticated 404 on `/.well-known/*` (AV12) |
| Orphaned or wrongly signalled processes on shutdown | child in its own process group; group kill on exit (AV10) |
| Relay stop hook stalls daemon sessions or leaks to the relay | `HITL_DAEMON_SESSION` guard in `hitl-cli`, unit-tested (AV11) and verified on real agy (CV6) |
| Early `reply_to_hitl` resolves a workflow delegation | `message_id` stripped in daemon mode; exactly one end-of-turn reply (AV7, AV9) |
| Permission card lost while the app is backgrounded wedges the session | re-sent on WS open; `/cancel` cancels pending (AV8, AV10) |
| Out-of-turn agent output bleeds into the next reply | separate out-of-turn buffer (AV5) |
| `present_choices_to_hitl` answers misrouted as permission outcomes | `pendingPermissions` first, then the open-card discriminator (AV8) |

### 6.2 Testing Strategy

- **Unit (bun test):** the session manager against a **fake ACP agent**, an in-process ndjson peer that scripts `session/update` chunks (in-turn and out-of-turn), `request_permission`, `stopReason`s, `session/list`, `session/resume`/`load` replay and child exit. Covers slash-command grammar, inbound routing order, queueing, cancel, permission correlation, delegation tagging and identity resolution.
- **Integration (bun test, ephemeral ports):**
  - daemon boot with the fake agent as a child process;
  - the full phone flow over real HTTP/WS (pair → POST → reply);
  - **two sequential sessions**, each doing MCP `server/discover` → `initialize` → `tools/call call_phone_tool` → `tool_call_request` frame → `tool_call_result` → MCP result;
  - an unauthenticated `/.well-known` probe → 404, and `/mcp` without a token → 401.
- **Wire smoke (scripted, not CI):** `scripts/acp_smoke.py` against the real `agy acp`. It runs the HTTP MCP injection with bearer, two sessions, `resume`, permission round-trip and the hook-guard marker.
- **E2E (CV):** a real phone against a real daemon over Tailscale.

## 7. Acceptance Criteria

### Agent-verifiable
- [ ] **AV1** Channel mode's `tools/list` output (names, descriptions, schemas) and `initialize` instructions are byte-identical before and after the refactor, pinned by a snapshot captured on the pre-refactor commit. `bun src/server.ts` and `hitl-channel` with no subcommand both start channel mode.
- [ ] **AV2** Identity, discovery and pairing:
  - **Identity.** `hitl-channel daemon --harness agy` (and `bun run src/daemon.ts --harness agy`) listens on 8790 by default and persists identity at `~/.hitl/channels/identity-daemon-agy.json`, with an `instanceId` different from `identity.json`.
  - **Discovery.** `GET /instance` returns that `instanceId` and `displayName = "agy@" + os.hostname()` (never `agy@unknown` on macOS), and mDNS advertises the same.
  - **Pairing.** `POST /pair/request` prints the 6-digit code to stdout and causes **zero** ACP RPCs. `/pair/validate` with that code returns a device token that authorises `POST /` and `/ws`.
- [ ] **AV3** With the fake ACP agent, a plain `POST /` message and a WS chat frame each produce exactly one `session/prompt` to the active session. The text equals what channel mode would deliver, including `questions_batch_response` formatting, which the WS path now shares.
- [ ] **AV4** An image attachment produces an ACP `{type:"image", data, mimeType}` block built from the original base64 + `media_type`, and is **not** written to the inbox. A non-image file goes through the existing `processAttachments` path, and its saved path appears in the prompt text.
- [ ] **AV5** Turn and out-of-turn replies:
  - **In-turn.** Chunks "a", "b", "c" followed by `stopReason: end_turn` produce exactly one `reply` frame with text "abc", routed through the reply buffer/ACK (reconnect-drain replay verified). A turn with no text produces the "(no text output — stopReason: …)" reply.
  - **Out-of-turn.** Chunks emitted after the turn ended arrive as a separate standalone reply and are **not** included in the next prompt's reply.
- [ ] **AV6** Loopback MCP across sessions:
  - **Tool round-trip.** Across **two sequential ACP sessions**, a `call_phone_tool` call reaching the loopback MCP endpoint (preceded by a pre-initialize `server/discover`, which gets a JSON-RPC response) produces a `tool_call_request` WS frame. The matching `tool_call_result` resolves the MCP call with the phone's output.
  - **Audit.** The audit line carries `acp_session_id` taken from `_meta["antigravity.google/conversation_id"]`.
- [ ] **AV7** Injected tool set:
  - **Tool list.** The daemon's injected MCP server exposes exactly `call_phone_tool`, `list_phone_tools`, `push_file`, `present_choices_to_hitl`, `present_questions_to_hitl`, `list_devices` and `reply_to_hitl`. Descriptions match channel mode's, except for `reply_to_hitl`'s daemon suffix.
  - **No `message_id`.** A daemon-mode `reply_to_hitl(text, message_id="X", attachments=[img])` broadcasts a `reply` frame with the attachment and **no** `message_id`.
  - **Instructions.** `DAEMON_INSTRUCTIONS` contains no instruction to reply with the inbound `message_id`, and no Claude Code version requirement.
- [ ] **AV8** Permissions:
  - **Card and outcome.** A `session/request_permission` for a non-hitl tool sends one `choices` frame whose choices are the option names. A following `choice_response` "Allow" sends exactly one response, `{outcome:{outcome:"selected", optionId:"allow"}}`. A second tap afterwards gets "no pending approval" and nothing is sent.
  - **Queueing.** A plain message sent while the approval is pending gets "⚠ waiting for your approval above (queued)" and is dispatched after the turn.
  - **Reconnect.** A pending card is re-sent with its **original `id`** when a WS client reconnects, via `onClientOpen`.
  - **Auto-allow.** Requests matching the agy identification rule in either form get an `allow` with no phone frame, audited as `kind:"permission", approval:"auto"` with `tool_name` populated. The two forms are fixtures modelled on the captured wire payload: `toolCall.name` = `mcp_hitl-channel_call_phone_tool`, or no `name` with `toolCall.title` = `Run mcp_hitl-channel_call_phone_tool`. A request matching neither form goes to the phone.
  - **Open card.** With no pending permission but an open `present_choices_to_hitl` card, a `choice_response` is forwarded as a `session/prompt`. With neither, it gets "no pending approval" and no ACP call is made.
- [ ] **AV9** An inbound message wrapped in `<workflow_delegation message_id="X">` yields exactly one frame with `message_id: "X"`: the end-of-turn reply, even if the agent called `reply_to_hitl(message_id="X")` during the turn.
- [ ] **AV10** Commands and process lifecycle:
  - **`/new`.** `/new ~/x` (existing dir) sends `session/new` with an **absolute** `cwd`, the `hitl-channel` HTTP MCP server (bearer header in `[{name,value}]` form), and `_meta.antigravity.systemPrompt.append = DAEMON_INSTRUCTIONS`. `/new hermes` in Phase 1, and `/new /nonexistent`, get error replies with no ACP call.
  - **`/sessions`.** Shows the top 10 by `updatedAt` descending, with the active session marked (appended if outside the top 10).
  - **`/resume`.** `/resume 2` resolves against the last listing and calls `session/resume` with that session's `cwd`, the current `mcpServers` and `_meta`. With `resume` unadvertised it falls back to `session/load`, and replayed updates are ignored.
  - **`/cancel`.** Cancels pending permissions (`{outcome:{outcome:"cancelled"}}`) and sends `session/cancel`; the turn ends cancelled.
  - **`/status` and `/help`.** Both reply as specified in §4.3a.
  - **Queueing.** The first plain message with no session auto-creates one. A message sent mid-turn is queued and dispatched FIFO afterwards.
  - **Crash and shutdown.** Killing the fake child produces an error reply, one restart and a "/resume" hint. On SIGTERM the child's process group is gone within 5 s.
- [ ] **AV11** Hook guard:
  - **Daemon side.** The harness child is spawned with `HITL_DAEMON_SESSION=1`.
  - **hitl-cli side.** With the variable set, `review_and_continue.py` `main()` (in both Antigravity and Claude Code modes), `review_and_continue_antigravity.py` and `review_and_continue_wrapper.sh` exit 0 with the per-harness stdout contract (Antigravity: `{"decision":"allow","reason":""}`; Claude Code: empty) and make no network call. Covered by unit tests in hitl-cli.
  - **Out of CI scope.** The real-agy end-to-end proof is CV6.
- [ ] **AV12** Loopback security and relay independence:
  - **Bind and auth.** The loopback MCP endpoint binds `127.0.0.1` only. `/mcp` returns 401 without the per-process bearer token; `GET /.well-known/oauth-protected-resource` returns 404 without auth.
  - **No relay.** A test asserts there are no `hitlrelay.app` references in `hitl-channel/src/`.
- [ ] **AV13** All pre-existing hitl-channel test files, **including `audit.test.ts`**, pass unmodified in channel mode. New daemon tests live in new files and use ephemeral ports. No file under `hitl-app` changes in Phase 1.

### CEO device-verify (work-with-CEO on device)
- [ ] **CV1** On a real phone over Tailscale: discover (or enter) `agy@<host>:8790`, pair with the code shown on the host, and send "hello". The agent's reply bubble appears. If you background the app before the reply lands, the reply and its local notification appear when you return to the app (reply-buffer drain).
- [ ] **CV2** From the phone:
  - `/new ~/lab/hitl`, then ask "what repo am I in?". The answer references hitl, and no HITL stop-hook ping arrives on the phone.
  - `/sessions` lists that session with an auto title.
  - `/resume` on an older CLI session continues it.
- [ ] **CV3** From the phone, ask the agy agent to "list my phone tools, create a test local agent on my phone, and send me a screenshot of the result". The phone's trust-tier sheet appears for the create. After approval the agent exists in the app, and an image arrives in chat.
- [ ] **CV4** Ask the agent to run a shell command that requires permission. An Allow/Deny card appears on the phone. Deny makes the agent report the denial; Allow on retry runs the command. Repeat with the app backgrounded when the request arrives: the card is there when you return.
- [ ] **CV5** With hitlrelay.app blocked on the Mac (e.g. `/etc/hosts`), CV1 and CV2 still pass, including `session/new`.
- [ ] **CV6** *(external-system: real `agy acp` on the dev Mac, run by the implementing agent with the CEO's machine)* `scripts/acp_smoke.py` passes against the real `agy acp`. It covers:
  - HTTP MCP injection with bearer auth across two sessions, plus `session/resume`;
  - a permission round-trip;
  - an injected `hitl-channel` tool call that is auto-allowed with **zero** phone `choices` frames (proves the identification rule on the live wire);
  - the hook-guard marker written with `HITL_HOOK_DEBUG=1` (proves `HITL_DAEMON_SESSION` reaches agy's hook subprocess).

  If that marker check fails, implementation stops and goes back to the CEO (§4.2 item 9).

### Two checks on the finished list
1. **Read as a set for contradictions.**
   - **AV5 vs AV8/AV10.** AV5 requires exactly one end-of-turn reply per turn; AV8/AV10 add queued and waiting acknowledgements. Those acknowledgements are separate replies to *different* inbound messages. Consistent.
   - **AV7 vs AV9.** `reply_to_hitl` is kept but has its `message_id` stripped, and AV9 asserts that only the end-of-turn frame carries X. Consistent.
   - **AV8 auto-allow vs CV3.** CV3's trust-tier sheet is the phone's own gate, independent of the ACP permission. Consistent.
   - **AV8 "no pending approval" vs the forwarding rule.** These are distinguished by the open-card count, so both hold.
   - **AV2 vs AV13.** The 8790 default is a CLI default; the tests use ephemeral ports. Consistent.
2. **Generated-string proxies.**
   - **AV1 and AV7** assert tool-list and instructions text. They are deliberate contract snapshots, and the behaviour behind them is covered by AV6, AV9 and CV3.
   - **AV11** asserts spawn env plus hitl-cli unit behaviour. The live-wire proof that the environment reaches agy's hook subprocess is CV6, so the proxy gap is covered by an explicit external check.

## 7a. User-Story → AC Traceability

| User story phrase | AC # | Notes |
|---|---|---|
| "`/new ~/lab/hitl` … fresh Antigravity session starts in that folder" | AV10, CV2 | |
| "next message goes to it" | AV3, AV10 | active session |
| "`/sessions` … title, folder, last activity" | AV10, CV2 | |
| "`/resume <n>` to switch … work the agent (or I) started earlier" | AV10, CV2 | shared agy session store; `session/resume` |
| "message sent mid-turn is queued" | AV10 | |
| "`/cancel` to stop the running turn" | AV10 | |
| "permission requests show up as tappable Allow / Deny … even if backgrounded" | AV8, CV4 | |
| "own LAN/Tailscale with the same pairing-code flow … no third party" | AV2, AV11, AV12, CV1, CV5, CV6 | |
| "tools in my tool list, plus standing orders" | AV7, AV10, CV3 | |
| "act on the phone as if I were running on it" | AV6, AV7, CV3 | |
| "`<workflow_delegation message_id=X>` resolves with the final answer" | AV9 | an on-device workflow CV is optional in Phase 1 (the app can already target the daemon as a Claude Code instance) |
| "existing stdio/channel mode untouched" | AV1, AV13 | |

## 8. Out of Scope (Phase 1)

- Native app session UI, streaming partials and harness badges (Phase 3, child `SPEC-HITL-APP-*`).
- Hermes and Codex (Phase 2).
- Phone-started sessions appearing *live* in a running agy TUI. Resuming them from the CLI through agy's shared store is possible but not required.
- Delivery while the app is backgrounded or killed. The behaviour stays as today: replies and notifications on reconnect via reply-buffer drain.
- Agent-initiated session creation (see the §4.3b parity statement).
- E2E encryption beyond the transport (unchanged from today; Tailscale/VPN recommended).
