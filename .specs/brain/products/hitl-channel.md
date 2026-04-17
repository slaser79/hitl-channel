---
title: "hitl-channel"
type: product
products: [hitl-channel]
last_updated: 2026-04-17
sources:
  - README.md
  - CLAUDE.md
  - package.json
  - tsconfig.json
  - .mcp.json.example
  - src/server.ts
  - src/http_bridge.ts
  - src/pairing.ts
  - src/allowlist.ts
  - src/identity.ts
  - src/mdns.ts
  - src/notification.ts
  - src/types.ts
  - .specs/01_system_context.md
  - .specs/02_roadmap.md
  - .specs/03_critic.md
  - .specs/features/SPEC-HC-001_pairing_system.md
  - .specs/features/SPEC-HC-002_mdns_discovery.md
  - .specs/features/SPEC-HC-003_channel_messaging.md
  - .specs/features/SPEC-HITL-CHAT-UNIFY_unified_chat_architecture.md
  - gh issues (#3, #5) + PRs (#1, #2, #4)
cross_refs:
  - ../index.md
---

# hitl-channel — Claude Code MCP Channel Plugin

> **Authoritative satellite page.** Every non-trivial claim cites a source file in this repo. The HQ mirror at `agent_workflows/.specs/brain/products/hitl-channel.md` is a pointer, not an authoritative source.

`hitl-channel` is a TypeScript Model Context Protocol (MCP) server that enables **direct bidirectional communication** between the HITL mobile app (`hitl-app`) and a Claude Code session, routed over LAN or Tailscale with no cloud relay (`README.md` §intro; `CLAUDE.md` §Project Overview; `.specs/01_system_context.md` §Overview). It is the privacy-first sibling of `hitl-cli` + `hitl-shin-relay`: where that stack speaks to `hitlrelay.app`, `hitl-channel` keeps every message on the local network.

## What it is

- **Transport:** MCP server over stdio (subprocess of Claude Code) + embedded HTTP/WebSocket bridge on port `8789` (`src/server.ts:13`, `src/http_bridge.ts:115–116`).
- **Protocol surface:** experimental `notifications/claude/channel` capability plus two custom tools — `reply_to_hitl` and `present_choices_to_hitl` (`src/server.ts:17–82`, `src/notification.ts:25–31`).
- **Requires:** Claude Code v2.1.80+ with research-preview channels (`README.md` §Prerequisites); started via `claude --dangerously-load-development-channels server:hitl-channel` (`README.md` §Start Claude Code with Channels).
- **Runtime of record:** Bun (not Node) — `package.json` `"scripts": { "start": "bun src/server.ts" }`, `tsconfig.json` `"types": ["bun"]`, and the code uses Bun-native APIs (`Bun.file`, `Bun.$`, `Bun.SHA256`, `Bun.serve`, `Bun.write`) throughout (`src/allowlist.ts:9`, `src/identity.ts:9`, `src/http_bridge.ts:118`, `src/http_bridge.ts:89`).

## Tech stack (pinned — verified against package.json)

- **Runtime:** Bun (recommended) or Node.js ≥20 (`README.md` §Prerequisites). `tsconfig.json` targets `ESNext`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `noEmit: true`.
- **MCP SDK:** `@modelcontextprotocol/sdk ^1.0.0` (`package.json` dependencies), wired as `Server` + `StdioServerTransport` in `src/server.ts:2–3`.
- **mDNS:** `bonjour-service ^1.3.0` (`package.json`), loaded dynamically via `require("bonjour-service")` in `src/mdns.ts:20` to keep it optional.
- **Dev deps:** `@types/bun: latest`, `typescript: ^5.9.3` (`package.json`).
- **Package state:** `"version": "0.0.1"`, `"type": "module"` (`package.json`). No CI workflows, no LICENSE file, no lint config in-repo as of 2026-04-17 — the repo is pre-1.0.

## Architecture (one screen)

Direct flow, no intermediary (`README.md` §Architecture, `.specs/01_system_context.md` §Architecture Overview):

```
hitl-app (phone)          hitl-channel (MCP subprocess)      Claude Code
    │                             │                                 │
    ├── POST /pair/request ──────▶│                                 │
    │                             ├──notifications/claude/channel──▶│ (6-digit code shown)
    ├── POST /pair/validate ─────▶│                                 │
    │◀── 200 { device_token } ────┤                                 │
    ├── POST / (msg, sender_id) ─▶├──notifications/claude/channel──▶│
    │                             │                                 │◀ reply_to_hitl tool
    │◀── WS /ws (reply payload) ──┤◀── broadcastReply() ────────────┤
```

Tokens are authenticated `Bearer` in the header, as `?token=` query param, or via legacy `?api_key=` fallback keyed on `HITL_CHANNEL_API_KEY` (`src/http_bridge.ts:22–58`).

## Key components (module map)

| File | LOC | Purpose | Key exports |
|------|-----|---------|-------------|
| `src/server.ts` | 153 | MCP server + tool registration; spawns HTTP bridge, mDNS, expiry sweeper | `mcp`, tool handlers for `reply_to_hitl` + `present_choices_to_hitl` |
| `src/http_bridge.ts` | 324 | Bun.serve HTTP + WebSocket bridge; pairing endpoints; message inbound; reply broadcast; attachment processing | `startHttpBridge`, `broadcastReply`, `clients` |
| `src/pairing.ts` | 89 | 6-digit code generation, 5-min expiry, single-use consume, periodic cleanup | `createPairingRequest`, `validatePairingCode`, `consumePairingCode`, `cleanupExpiredPairings` |
| `src/allowlist.ts` | 137 | SHA-256-hashed device tokens persisted to `~/.hitl/channels/allowlist.json` | `addToAllowlist`, `isTokenAllowed`, `hashToken`, `removeFromAllowlist` |
| `src/identity.ts` | 109 | Persistent instance UUID + displayName resolution (env → hostname) | `getIdentity`, `loadIdentity` |
| `src/mdns.ts` | 76 | Advertises `_hitl-channel._tcp` on port 8789; TXT = version/instanceId/displayName | `startMDNS`, `stopMDNS`, `isMDNSAdvertising` |
| `src/notification.ts` | 33 | `sendChannelNotification` wrapper around `mcp.notification({ method: "notifications/claude/channel" })` | `sendChannelNotification` |
| `src/types.ts` | 38 | TypeScript interfaces: `HitlMessage`, `HitlAttachment`, `ChannelMeta`, `ReplyPayload`, `HitlWebSocket` | — |

Note: `.specs/03_critic.md` §Test Architecture documents a `src/__tests__/` directory with `allowlist.test.ts`, `pairing.test.ts`, `pairing-integration.test.ts`, `server.test.ts`, but the directory is empty on `main` as of 2026-04-17 (verified via `gh api repos/slaser79/hitl-channel/contents/src/__tests__`) — the test scaffolding is aspirational. Treat `bun test` as unwired until the `.test.ts` files ship.

## HTTP / WS surface (authoritative)

From `src/http_bridge.ts` (not the README aspirational table):

| Route | Method | Auth | Behavior | Source |
|-------|--------|------|----------|--------|
| `/health` | GET | No | `{ status, port, clients }` | `src/http_bridge.ts:125–130` |
| `/instance` | GET | No | `{ instanceId, hostname, displayName }` | `src/http_bridge.ts:133–145` |
| `/pair/request` | POST | No | Generates 6-digit code, pushes via `notifications/claude/channel`, returns 202 `{ status: "pending", expires_in: 300 }` | `src/http_bridge.ts:148–173` |
| `/pair/validate` | POST | No | Validates `{ code }`: 400 if bad format, 403 if expired/unknown, 200 `{ status: "paired", device_token }` if good; token added to allowlist as SHA-256 hash | `src/http_bridge.ts:176–223` |
| `/` | POST | Yes | Delivers `{ message \| content, sender_id, agent_id?, attachments? }` to Claude Code as a channel notification; 400 on empty body; returns `{ status: "delivered" }` | `src/http_bridge.ts:241–286` |
| `/ws` | GET (upgrade) | Yes | WebSocket — server broadcasts `reply` payloads to every connected client whose `readyState === 1` | `src/http_bridge.ts:235–238, 60–76, 291–321` |

## Storage

All persistent state lives under `~/.hitl/channels/` (`README.md` §Data Storage; `src/allowlist.ts:11–12`; `src/identity.ts:11–12`):

- `identity.json` — `{ instanceId: UUID, hostname, displayName, createdAt }`. Stable across restarts. Created on first boot.
- `allowlist.json` — `{ entries: { [tokenHash]: { tokenHash, addedAt, lastUsed? } } }`. Device tokens are stored as SHA-256 hashes only; the plaintext token lives only in the client after `POST /pair/validate` (`src/allowlist.ts:65–88`).

Attachments from mobile: `~/.claude/channels/hitl-channel/inbox/` receives base64-decoded images; the file path is appended to the channel notification as `[Image: /abs/path]` (`src/http_bridge.ts:82–111`).

## Environment variables

- `HITL_CHANNEL_PORT` (default `8789`) — HTTP/WebSocket bridge port (`src/server.ts:13`, `src/http_bridge.ts:115`).
- `HITL_CHANNEL_API_KEY` — legacy API-key fallback; matched against `?api_key=` or Bearer token (`src/http_bridge.ts:36–55`).
- `HITL_CHANNEL_NAME` — display name override for this instance; persisted back into `identity.json` when changed (`src/identity.ts:58`, `:84–87`; `CLAUDE.md` §Environment Variables).

## Status (roadmap snapshot — `.specs/02_roadmap.md`)

- **Complete:** Phase 1 Core MCP Server; Phase 2 Secure Pairing (code + expiry + SHA-256 allowlist); Phase 4 Attachment Support (image decode, `~/.claude/channels/hitl-channel/inbox`).
- **Partial:** Phase 3 Identity & Discovery — instance identity + mDNS advertisement shipped; **mDNS fix for MCP subprocess mode is open as `#3`**; Tailscale peer discovery not started. Phase 5 Multi-Instance — unique IDs + `agent_id` routing shipped; instance-selection UI and cross-instance routing TBD.
- **Planned:** Phase 6 Production Hardening (reconnect, rate-limit, token revocation, audit logging). Phase 7 E2E Encryption (ECDH pairing, per-session keys).

Recent delivery history (`gh pr list --repo slaser79/hitl-channel --state all`, 2026-04-17):

- **PR #1 merged:** `feat: Add display name for multi-instance identification` — wired `HITL_CHANNEL_NAME` env into `identity.ts` + mDNS TXT records.
- **PR #2 merged:** `feat: Add image attachment support to channel bridge` — `processAttachments()` + `~/.claude/channels/hitl-channel/inbox` (`src/http_bridge.ts:82–111`).
- **PR #4 merged:** `feat: Add present_choices_to_hitl MCP tool` — second tool exposed to Claude Code for multi-choice prompts over the same WebSocket (`src/server.ts:56–81`, `:103–129`).

Open issues:

- **#3 (P1, bug):** `mDNS discovery not working when running as Claude Code MCP subprocess` — documented root-cause hypotheses (multicast socket access, macOS firewall, stdio capture) and three proposed fixes (detached mDNS daemon, Tailscale API discovery, central discovery service) in `.specs/features/SPEC-HC-002_mdns_discovery.md`. Workaround: manual IP:port entry.
- **#5 (open):** `fix: Add .gitignore exception for .claude/empire_context.yaml` — cross-repo ops hygiene; mirrors the same fix shipped across every other satellite in this empire.

## Known gotchas

1. **mDNS silently fails as a Claude Code subprocess.** `dns-sd -B _hitl-channel._tcp` returns nothing, no error is logged, but standalone `bun src/server.ts` works. Tracked as `#3` / `SPEC-HC-002` (`Blocked`). Always fall back to manual IP:port until fixed — don't assume discovery works just because `startMDNS` returned without throwing (`.specs/features/SPEC-HC-002_mdns_discovery.md` §Known Issue).
2. **stdout is reserved for MCP.** All logging goes to `process.stderr` — switching to `console.log` will corrupt the stdio transport (`CLAUDE.md` §Code Style; every `src/*.ts` uses `process.stderr.write`).
3. **No rate limiting on `/pair/request` or `/pair/validate`.** Five-minute expiry bounds brute force at roughly 200k attempts per window (1M code space); acceptable for now, flagged in `SPEC-HC-001` §Security Considerations as a TODO for production.
4. **No E2E encryption over the wire.** Security rests on LAN / Tailscale network trust (`.specs/01_system_context.md` §Known Limitations). Phase 7 adds ECDH but is not started.
5. **Session-less chat.** Per `SPEC-HITL-CHAT-UNIFY §2`, hitl-channel is the only HITL chat surface without sessions or history — replies broadcast to every connected WebSocket client (`src/http_bridge.ts:60–76`). That spec proposes a unified architecture across hitl-channel + hitl-openclaw + hitl_agents + hitl_requests; the work lives in `hitl-app`, not here.
6. **Test scaffolding is aspirational.** `.specs/03_critic.md` describes `src/__tests__/*.test.ts` but the directory is empty on main. Any CRITIC verification MUST run live HTTP / MCP checks, not rely on `bun test`.
7. **WebSocket broadcast is global.** `broadcastReply` sends to every client; there is no per-session or per-device addressing yet (`src/http_bridge.ts:60–76`). Multi-device paired setups will see each other's replies.

## Related empire products

- [`hitl-app`](https://github.com/slaser79/hitl-app) — Flutter mobile app that pairs with this server (`README.md` §Related Projects; `SPEC-HITL-CHAT-UNIFY` §2).
- [`hitl-cli`](https://github.com/slaser79/hitl-cli) — Python CLI + SDK for **relay-based** HITL via `hitlrelay.app`; not this direct-LAN path.
- [`hitl-shin-relay`](https://github.com/slaser79/hitl-shin-relay) — the cloud relay that `hitl-cli` and `hitl-app` use when LAN/Tailscale isn't available.
