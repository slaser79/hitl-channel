---
cross_refs:
- ../index.md
- ../products/hitl-channel.md
- ../lessons/cross-repo-mission-delivery.md
last_updated: '2026-06-14'
products:
- hitl-channel
sources:
- hitl-channel:README.md (usage, architecture, endpoints, env vars, storage)
- hitl-channel:CLAUDE.md (project overview, code style, known issues)
- hitl-channel:package.json (deps, scripts, version pins)
- hitl-channel:tsconfig.json (Bun types, strict mode, ESNext)
- hitl-channel:.mcp.json.example (recommended Claude Code wiring)
- hitl-channel:src/server.ts (MCP server + tool registration)
- hitl-channel:src/http_bridge.ts (HTTP + WebSocket bridge, auth, attachments)
- hitl-channel:src/pairing.ts (6-digit codes, 5-min expiry)
- hitl-channel:src/allowlist.ts (SHA-256 hashed device tokens)
- hitl-channel:src/identity.ts (instance identity persistence)
- hitl-channel:src/mdns.ts (bonjour-service advertisement)
- hitl-channel:src/notification.ts (notifications/claude/channel wrapper)
- hitl-channel:src/types.ts (HitlMessage / ReplyPayload interfaces)
- hitl-channel:.specs/01_system_context.md
- hitl-channel:.specs/02_roadmap.md
- hitl-channel:.specs/03_critic.md
- hitl-channel:.specs/features/SPEC-HC-001_pairing_system.md
- hitl-channel:.specs/features/SPEC-HC-002_mdns_discovery.md
- hitl-channel:.specs/features/SPEC-HC-003_channel_messaging.md
- hitl-channel:.specs/features/SPEC-HITL-CHAT-UNIFY_unified_chat_architecture.md
- gh issue list / gh pr list --repo slaser79/hitl-channel --state all (2026-04-17)
title: hitl-channel Lessons
type: lesson
---
# hitl-channel Lessons

Curated from `hitl-channel`'s own README.md, CLAUDE.md, package.json, tsconfig.json, every TypeScript module under `src/`, the four feature specs in `.specs/features/`, the roadmap, the CRITIC guide, and the 2 open issues + 3 merged PRs in `slaser79/hitl-channel` (history snapshot 2026-04-17). Every lesson is traceable to a cited source in the satellite repo. The satellite does not yet have its own `.specs/lessons_learned.md`; this HQ page is the authoritative lessons register until one exists.

### Bun is the runtime, Node is the fallback — don't "port to Node" casually

- **Why it matters:** `package.json` scripts call `bun src/server.ts` (not `node`), `tsconfig.json` declares `"types": ["bun"]`, and the code is saturated with Bun-native APIs: `Bun.serve` (`src/http_bridge.ts:118`), `Bun.file` + `Bun.write` (`src/allowlist.ts:41/59`, `src/identity.ts:38/75`), `Bun.$` shell (`src/allowlist.ts:29`, `src/identity.ts:26`), `Bun.SHA256.hash` (`src/allowlist.ts:67`). A Node port has to replace every one of those call sites; a quick swap will silently fail at runtime.
- **Operational consequence:** PRs that touch `src/*.ts` must run under Bun (≥1.0), not whatever `node` is on `PATH`. The README-stated fallback "Node.js 20+" is aspirational — no Node-compat shim exists today.
- **Source:** `hitl-channel:package.json` scripts + deps; `hitl-channel:tsconfig.json` `"types": ["bun"]`; `hitl-channel:README.md` §Prerequisites.

### stdout is reserved for MCP — every log goes to stderr

- **Why it matters:** hitl-channel runs as a stdio-transport MCP subprocess of Claude Code (`src/server.ts:3, 150`). Writing to `stdout` (e.g. `console.log(...)`) would inject noise into the MCP JSON-RPC stream and break the channel. Every file in `src/` uses `process.stderr.write(...)`.
- **Operational consequence:** Workers dispatched to this repo must avoid `console.log` entirely; use `process.stderr.write("[hitl-channel] ...")`. Reviewers should reject any PR that introduces stdout output. CRITIC must grep for `console.log` in diff.
- **Source:** `hitl-channel:CLAUDE.md §Code Style` ("Process.stderr for logging (stdout reserved for MCP)"); every `src/*.ts`.

### Claude Code channel-mode gating — this plugin is research-preview only

- **Why it matters:** The plugin uses the experimental `notifications/claude/channel` MCP capability (`src/server.ts:19`, `src/notification.ts:26`). Claude Code only exposes it behind `--dangerously-load-development-channels server:hitl-channel` on v2.1.80+ (`README.md` §Start Claude Code with Channels, §Prerequisites). If an operator runs `claude` without the flag, the tool registration completes but channel notifications are silently ignored.
- **Operational consequence:** Installation docs and Docker wrappers MUST surface the flag prominently. Any "it installs but doesn't work" bug is usually the missing flag, not the code.
- **Source:** `hitl-channel:README.md` §Prerequisites + §Start Claude Code with Channels; `hitl-channel:src/server.ts` capabilities block.

### Test scaffolding described in `.specs/03_critic.md` does not exist on disk

- **What happened:** `.specs/03_critic.md` §Test Architecture documents `src/__tests__/allowlist.test.ts`, `pairing.test.ts`, `pairing-integration.test.ts`, `server.test.ts`. The directory is empty on `main` as of 2026-04-17 (verified via `gh api repos/slaser79/hitl-channel/contents/src/__tests__`; the README §Development still says `bun test`).
- **Operational consequence:** Do NOT gate CRITIC reports on "bun test passes" — it passes because there are zero tests to run. CRITIC for this satellite must verify end-to-end: spin up the bridge, call `POST /pair/request`, confirm the channel notification arrives, validate code, confirm token lands in the allowlist. Workers shipping new features MUST add the corresponding `.test.ts` files — being the first to introduce real tests is in-scope for any production-hardening PR.
- **Source:** `hitl-channel:.specs/03_critic.md §Test Architecture + §Running Tests`; `hitl-channel:README.md §Development`; `gh api repos/slaser79/hitl-channel/contents/src/__tests__` (empty).

### mDNS silently fails in Claude Code subprocess mode (issue #3)

- **What happened:** `startMDNS()` completes without throwing (`src/mdns.ts:29–40`) but `dns-sd -B _hitl-channel._tcp` returns nothing when hitl-channel is launched as a Claude Code MCP subprocess. Standalone `bun src/server.ts` works. Hypotheses documented in `SPEC-HC-002 §Known Issue`: multicast UDP permission, macOS firewall on unsigned subprocesses, network-interface visibility, stdio capture interfering with bonjour internals.
- **Operational consequence:** Never trust "mDNS advertising started" stderr as proof of discovery. Until `#3` ships, onboarding flows MUST surface manual IP:port entry. Tailscale peer discovery (Phase 3 backlog item in `.specs/02_roadmap.md`) is the most likely real fix.
- **Source:** `slaser79/hitl-channel#3` (open, P1 bug); `hitl-channel:.specs/features/SPEC-HC-002_mdns_discovery.md` §Known Issue + §Proposed Fixes; `hitl-channel:src/mdns.ts:41–43`.

### No rate-limiting on `/pair/request` or `/pair/validate` — five-minute expiry is the only brake

- **Why it matters:** `SPEC-HC-001 §Security Considerations` explicitly flags rate limiting as a TODO for production; the code path in `src/http_bridge.ts:148–223` does no per-IP throttling. The only brute-force bound is the 5-minute window plus 1M code space ⇒ ~200k attempts/sec to crack a code in-window.
- **Operational consequence:** When hardening for production (roadmap Phase 6), the pairing endpoints need per-IP rate limits and ideally a captcha / device-attestation step. Don't claim "secure by design" in CEO summaries without this.
- **Source:** `hitl-channel:.specs/features/SPEC-HC-001_pairing_system.md §Security Considerations`; `hitl-channel:src/http_bridge.ts:148–223`; `hitl-channel:.specs/02_roadmap.md §Phase 6`.

### Device tokens are stored as SHA-256 hashes — never regress to plaintext

- **What happened:** `POST /pair/validate` generates a UUID (`src/http_bridge.ts:13–15`) and `addToAllowlist()` stores **only the SHA-256 hash** (`src/allowlist.ts:77–88`). Plaintext lives only on the mobile client. `isTokenAllowed` recomputes the hash on every request and returns boolean (`src/allowlist.ts:94–105`).
- **Operational consequence:** Any future auth feature (token revocation per `.specs/02_roadmap.md §Phase 6`, rotation, multi-device management) must preserve the hash-only invariant. A plaintext `allowlist.json` on disk is a security regression.
- **Source:** `hitl-channel:src/allowlist.ts:65–88`; `hitl-channel:.specs/features/SPEC-HC-001_pairing_system.md §Device Token + §Security Considerations`.

### No per-session routing — `broadcastReply` fans out to every WebSocket client

- **Why it matters:** `src/http_bridge.ts:60–76` sends each reply to every `clients` entry whose `readyState === 1`. There is no `sessionId` / `deviceId` filtering. Multi-device paired setups will see each other's replies. `SPEC-HITL-CHAT-UNIFY §2` calls this out as "Claude Code Channel — flat, no history, no sessions".
- **Operational consequence:** Any multi-device UX work must either (a) add session addressing here or (b) land the cross-product `SPEC-HITL-CHAT-UNIFY` (owned by `hitl-app`, not this repo) first. Don't design features that assume per-device delivery on top of the current broadcast.
- **Source:** `hitl-channel:src/http_bridge.ts:60–76` (`broadcastReply` iterates `clients`); `hitl-channel:.specs/features/SPEC-HITL-CHAT-UNIFY_unified_chat_architecture.md §2 The Four Chat Types Today`.

### Attachments land at `~/.claude/channels/hitl-channel/inbox/` — cite the path, don't make one up

- **What happened:** PR #2 "feat: Add image attachment support to channel bridge" wired base64 → disk → channel notification with `[Image: /path]` appended (`src/http_bridge.ts:82–111`). The inbox directory is hardcoded relative to `$HOME` and created on demand via `Bun.$`.
- **Operational consequence:** Specs / tests / docs that reference attachments must use the canonical path. File cleanup / rotation is not implemented — flag it as a follow-up ticket when discussing long-running deployments.
- **Source:** `slaser79/hitl-channel#2` (merged); `hitl-channel:src/http_bridge.ts:82–111`; `hitl-channel:README.md §Data Storage`.

### Two MCP tools shipped, expect more — PR #4 set the precedent

- **What happened:** PR #4 "feat: Add present_choices_to_hitl MCP tool" added a second tool alongside `reply_to_hitl` (`src/server.ts:56–81`, `:103–129`). The dispatch payload uses a WebSocket `type: "choices"` message; mobile receives and renders it.
- **Operational consequence:** New tool additions follow this pattern: (1) register in `ListToolsRequestSchema` handler, (2) branch in `CallToolRequestSchema` handler, (3) broadcast a typed JSON payload to `clients`, (4) add the matching renderer on the hitl-app side (`SPEC-HITL-CHAT-UNIFY` is the forcing function for that UI). Follow suit; don't invent a second broadcast path.
- **Source:** `slaser79/hitl-channel#4` (merged); `hitl-channel:src/server.ts:30–132`.

### `HITL_CHANNEL_NAME` env overrides persisted identity — and is re-saved

- **What happened:** PR #1 "feat: Add display name for multi-instance identification" wired `HITL_CHANNEL_NAME` into `identity.ts`; `getIdentity()` *always* prefers the env var over the stored `displayName` and writes the update back to disk (`src/identity.ts:84–87`). The mDNS TXT records and `/instance` endpoint both expose it.
- **Operational consequence:** Don't treat `identity.json` as the source of truth for display name — the env always wins, and the file is eventually consistent. Configuration management tools that set the env on each boot will re-stamp the file.
- **Source:** `slaser79/hitl-channel#1` (merged); `hitl-channel:src/identity.ts:58, 80–90`; `hitl-channel:src/mdns.ts:33–38`.

### `gitignore` parity with the rest of the empire (open issue #5)

- **What happened:** Open issue #5 "fix: Add .gitignore exception for .claude/empire_context.yaml" mirrors the same cross-satellite hygiene fix that shipped on `voice_chat#508`, `shin-web#42`, `resume-tailor#157`, `hitl-shin-relay#500`, and elsewhere during MISSION-2026-310b.
- **Operational consequence:** When dispatching to this repo, roll `#5` into whichever next PR touches the tree — it is a one-line `.gitignore` exception, not a mission of its own. Cross-repo-mission-delivery.md is the pattern registry for these fleet fixes.
- **Source:** `slaser79/hitl-channel#5` (open); analogous fixes cited in [cross-repo-mission-delivery.md](cross-repo-mission-delivery.md).

## Known hazards

### MCP + channel capability is research-preview — breaking changes possible

The `notifications/claude/channel` experimental capability (`src/server.ts:19`) is not part of a stable MCP release. A Claude Code update can change the notification shape, drop the capability, or rename it. Any CI check that asserts protocol specifics must be annotated as a regression guard pointing at the Claude Code release notes — do not treat a green test as proof that the protocol hasn't silently shifted.

### LAN security model is pure network trust — treat sensitive missions accordingly

There is no E2E encryption (Phase 7 is "planned", `.specs/02_roadmap.md`). On a hostile LAN, an attacker with bridge port reachability plus a valid pairing window can pair. Deployments on public Wi-Fi must either (a) bind to Tailscale only, (b) restrict via host-level firewall, or (c) wait for Phase 7. Don't claim "privacy-first" without this caveat in CEO-facing copy.

## Agent dispatch hints

- **Codex / Gemini Pro** for changes to `src/http_bridge.ts` (auth branches, WebSocket lifecycle, attachment handling — moderate blast radius, stdio-sensitive), `src/server.ts` (tool registration), or anything in `.specs/features/SPEC-HC-00{1,2,3}`.
- **Gemini Flash / Qwen** for `.gitignore` / docs / CHANGELOG hygiene (e.g., #5), small `.mcp.json.example` tweaks, bumping the `version` string in `package.json`.
- **Claude (spec_reviewer / critic roles)** for spec authoring, CRITIC verification of protocol behavior (channel notifications, tool responses), and any mission that touches the Empire Brain itself (this mission is a canonical example).
- **Always pair with `hitl-app`** for end-to-end changes — a new MCP tool here needs a matching renderer on the app side per `SPEC-HITL-CHAT-UNIFY`.

## Related HQ lessons

- [cross-repo-mission-delivery.md](cross-repo-mission-delivery.md) — hitl-channel ↔ hitl-app handoff discipline; `#5` gitignore sweep is a canonical example.
- [pr-triage.md](pr-triage.md) — PR review and merge discipline shared across the empire.

### What happened
*Distilled:* MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260428-18-what-happened-395b3735

### Lessons distilled
*Distilled:* Test scaffolding can lie.** `.specs/03_critic.md` describes a `src/__tests__/`; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260428-19-lessons-distilled-6a22dd18

### What happened
*Distilled:* MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260428-20-what-happened-395b3735

### Lessons distilled
*Distilled:* Test scaffolding can lie.** `.specs/03_critic.md` describes a `src/__tests__/`; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260428-21-lessons-distilled-6a22dd18

### What happened
*Distilled:* MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260502-22-what-happened-fb6a3db8

### Lessons distilled
*Distilled:* Test scaffolding can lie.** `.specs/03_critic.md` describes a `src/__tests__/`; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260502-23-lessons-distilled-8b60008c

### What happened
*Distilled:* MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260606-24-what-happened-043bb56e

### Lessons distilled
*Distilled:* Test scaffolding can lie.** `.specs/03_critic.md` describes a `src/__tests__/`; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260606-25-lessons-distilled-03e8e5dd

### What happened
*Distilled:* MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from; see .specs/brain/_journal/lessons/hitl-channel-lessons-2026-06.md#dist-20260606-26-what-happened-043bb56e
