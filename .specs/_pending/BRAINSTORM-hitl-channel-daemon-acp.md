# Brainstorm Brief — hitl-channel daemon mode (ACP) for agy / Hermes / Codex

## Goal & Outcome
Make hitl-app a first-class, **relay-free** remote for *any* coding harness on the CEO's machines — not just Claude Code. From the phone: push messages into a running session, **start / list / resume sessions**, approve permissions. And critically, keep the **inversion**: the remote agent drives the phone through the phone tool bridge (`call_phone_tool`, `list_phone_tools`, `push_file`, …, SPEC-HITL-CC-001), so it can act as if it ran on-device (create local agents, troubleshoot, dev loop).

Why now: the HITL MCP (relay) path only talks one way. It long-polls a socket for ~15 min and can't start a new session or push into a running one. CC channels can, but only for Claude Code.

## Decided (the converged shape)
- **Evolve hitl-channel, don't replace it.** Add a long-lived `hitl-channel daemon --harness <h>` mode that acts as an **ACP client** to the harness (`agy acp` first). *Why:* it reuses the proven top half (HTTP/WS API, pairing, allowlist, mDNS, reply buffer, correlator, audit) and keeps the blast radius small. CEO explicitly asked for "leverage what we built, viable, improve later".
- **Direct, relay-free, privacy-first.** LAN / Tailscale / any VPN the user picks. Notifications stay app-local (`claude_code_notification_service.dart` → `LocalNotificationService`; hitl-channel has no FCM). *Why:* privacy-conscious users get no intermediary, the same as CC channels today.
- **Phone tool bridge kept.** The daemon serves its existing MCP tools and injects them into every ACP `session/new.mcpServers`. *Why:* this is the core value prop.
- **Map onto existing frames, so hitl-app needs zero changes in Phase 1:**
  - phone `POST /` → ACP `session/prompt` (replaces `sendChannelNotification`)
  - `session/update` `agent_message_chunk`s are collected per turn → existing `broadcastReply()` → `reply` frame
  - `session/request_permission` → existing `choices` frame; phone `choice_response` → resolves the permission
  - each daemon session shows up as a normal "Claude Code" instance (the connection pool already handles many)
- **Phase 1 sessions via chat slash commands** that the daemon intercepts (`/new [harness] [cwd]`, `/sessions`, `/resume <id>`), backed by ACP `session/new` / `session/list` / `session/load`. *Why:* covers "new session" and "target a running session" without touching the app.
- **Rollout:** P1 agy (dogfood) → P2 `hermes acp`, then Codex via the `codex-acp` adapter → P3 app UX (a generic "Host Agent" type instead of the hardcoded `AgentType.claudeCode`, harness badge, session list, New-session button, streaming). **Claude Code stays on channel mode**, so its TUI keeps working.

## Affected repos / surfaces
- `hitl-channel` (P1–P2)
  - `src/server.ts` (1263 LOC): MCP tool handlers (`reply_to_hitl` :62, `list_devices` :134, `present_choices_to_hitl` :142, `list_phone_tools` :172, `call_phone_tool` :193, `push_file` :225, dispatcher :434). Extract them into a transport-agnostic module that both modes share.
  - `src/http_bridge.ts` (958 LOC): `POST /` handler :566, `/pair/request` :463 (pairing code goes to stdout/log instead of a channel notification), `broadcastReply` ~:215.
  - `src/notification.ts`: the channel-notification seam to swap out.
  - `src/mdns.ts`: daemon mode probably fixes issue #3 (mDNS fails in subprocess mode).
  - New: ACP client (`@agentclientprotocol/sdk`), harness registry, session manager.
- `hitl-app` (P3 only): `packages/hitl_agents/lib/src/services/claude_code_*.dart`, `channels/claude_code_*.dart` (~4.2k LOC), `hitl_core/.../agent_workflow_step.dart` (`AgentType.claudeCode`).
- `hitl-shin-relay`: none.

## Considered & rejected
- **Per-session wrapper (`hitl-acp --agent agy`, web-LLM proposal)**: you still start every session at the keyboard, which is the gap we're closing.
- **MCP-everywhere (hitl-channel as a plain MCP server in agy/codex TUIs)**: the tool bridge works, but inbound is the same long-poll pain and there are no new sessions. *Could still be a cheap complement later.*
- **Native per-harness remote APIs** (agy `remote-control`, codex `app-server`, a Hermes messaging gateway like the OpenClaw precedent SPEC-HITL-APP-030): N one-off integrations, and agy remote-control is a closed cloud path.
- **New standalone repo/daemon architecture**: over-engineered for now.

## Spike results — `agy acp` 1.5.11 (2026-11-21, all PASS)
Scripts: `~/.gemini/antigravity/brain/6dde1f9a-582a-4309-b6f3-2274ac93650a/scratch/{acp_probe_init,acp_probe_session,spike_mcp}.py`

| # | Question | Result |
|---|---|---|
| 1 | Capabilities | `loadSession: true`; `sessionCapabilities`: `resume`, `close`, `load`, `list`, `additionalDirectories`; `promptCapabilities.image: true`. **No `mcpCapabilities` advertised.** |
| 2 | stdio MCP injected via `session/new.mcpServers` | ✅ agent called `mcp_hitlspike_spike_ping` and returned the secret token |
| 3 | **HTTP** MCP injected (`{type:"http", url}`) | ✅ works despite nothing advertised (it probes `/.well-known/oauth-protected-resource` first, then falls through). **No stdio shim needed**: the daemon can serve its phone tools on localhost HTTP. |
| 4 | Per-session attribution of tool calls | ✅ every `tools/call` carries `_meta["antigravity.google/conversation_id"]` = ACP `sessionId`, so the daemon knows which session is driving the phone |
| 5 | Inject standing orders (`MCP_INSTRUCTIONS`) | ✅ `session/new._meta.antigravity.systemPrompt.append` is honoured (test instruction obeyed) |
| 6 | Permissions | `session/request_permission` with options `allow`(allow_once) / `deny`(reject_once), including for injected MCP tools. Maps 1:1 onto a `choices` frame. **Design note:** the daemon should auto-allow its *own* hitl tools (the phone already gates them with trust tiers), or the user gets double-prompted. |
| 7 | `session/list` | ✅ returns **all** agy ACP sessions in the app-data dir (incl. older ones), with title + cwd + updatedAt, so `/sessions` + `/resume` come for free |
| 8 | Streaming | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update`, `session_info_update` (auto title), `usage_update`, so there's enough for rich phone UX later |
| 9 | Latency | 83 s / 176 s for a trivial turn. **Root cause (CEO): the user's agy stop hook fired inside the ACP sessions** (pinged the phone with PONG) and blocked the turn until he answered. So it's not ACP overhead. Re-measure without the hook in P1. |
| 10 | User customizations load in ACP mode | ⚠️ `agy acp` loads the user's hooks/plugins/skills. **Requirement:** the daemon must control which customizations load for phone-driven sessions (dedicated `--app-data-dir`/profile, or a suppression env var the hooks respect). Otherwise HITL-pinging hooks are redundant and can block the session. |

## Open questions / deferred
- ~~HTTP MCP vs stdio shim~~ → **resolved: HTTP works** (spike #3)
- Process model for multiple sessions: one `agy acp` with N sessions, or `--process-per-session`? → spec
- Latency of a trivial turn (spike #9) → spec / P1 tuning
- Whether ACP sessions are visible/resumable from the agy TUI (shared store?) → nice-to-have, check during P1
- Streaming partials to the phone (vs. a per-turn reply) → P3
- Notifications when the app is killed (local-only today, replay on reconnect) → later
- Naming: in hitl-shin-relay "ACP" already means "Awesome ChatGPT Prompts" (SPEC-AW-278, `archive_acp_agents.py`), so disambiguate in specs.
- Codex: the `codex-acp` adapter's maturity vs. codex `app-server` → P2

## Suggested next stage
- [x] Spike: `agy acp` capabilities + HTTP MCP injection + tool call round-trip
- [ ] empire-spec (hitl-channel, SPEC-HC-005-ish: daemon mode / ACP client)

## Provenance
- Brainstormed with CEO via mcp_hitl on 2026-11-21; rounds: 3 (framing, architecture, lean recommendation) + convergence.
