---
title: "MISSION-2026-310b PHASE-9 — hitl-channel brain ingestion"
type: lesson
products: [hitl-channel, agent_workflows]
source: MISSION-2026-310b PHASE-9
task_id: task-3388a264-7bbf-4550-a53c-1cacd532e322
---

## What happened

MISSION-2026-310b PHASE-9 curated the satellite brain for `hitl-channel` from
first-party sources (README, CLAUDE.md, `.specs/01_system_context.md`,
`.specs/02_roadmap.md`, `.specs/03_critic.md`, four feature specs, and every
TypeScript module under `src/`), plus the 2 open issues and 3 merged PRs on
`slaser79/hitl-channel`.

## Lessons distilled

- **Test scaffolding can lie.** `.specs/03_critic.md` describes a `src/__tests__/`
  directory with four `.test.ts` files, but the directory is empty on `main`.
  Any CRITIC work for this satellite must run live HTTP / MCP checks, not rely
  on `bun test` as proof of correctness.
- **stdout is sacred in MCP subprocess mode.** Every `src/*.ts` logs via
  `process.stderr.write`. A one-liner `console.log` added in passing would
  corrupt the stdio transport between Claude Code and this server.
- **Bun, not Node.** `package.json` scripts call `bun src/server.ts`, the TS
  config `"types": ["bun"]`, and code uses `Bun.file` / `Bun.$` / `Bun.SHA256` /
  `Bun.serve` / `Bun.write`. A "drop in Node compatibility" refactor would
  have to replace every one of those call sites.
- **mDNS works in standalone mode but silently fails as a Claude Code subprocess
  (#3).** The advertisement call succeeds and nothing is logged, but discovery
  returns nothing. Workers on this repo must treat "discovery works" as
  unverified until `SPEC-HC-002` ships.
- **No rate-limiting on pairing endpoints.** Five-minute expiry is the only
  brute-force bound today. Production hardening (Phase 6 of the roadmap)
  will need rate limits on `/pair/request` and `/pair/validate`.
- **Session-less WebSocket broadcast.** `broadcastReply` fans out replies to
  every connected client, with no per-device or per-session addressing.
  `SPEC-HITL-CHAT-UNIFY` in `hitl-app` is the follow-up that solves this at
  the ecosystem level.
