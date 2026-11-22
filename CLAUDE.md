# CLAUDE.md - hitl-channel

## Project Overview

hitl-channel is a TypeScript MCP and ACP bridge that enables direct bidirectional communication between the HITL mobile app and host coding agents — either **Claude Code Channels** (`src/server.ts`, default port `8789`) or **ACP Daemon Mode** (`src/cli.ts daemon` / `src/daemon.ts` for `agy` `:8790`, `codex` `:8791`, `hermes` `:8792`). It provides a privacy-first alternative to cloud relays by routing messages over LAN or Tailscale.

## Quick Start

```bash
# Install dependencies
bun install

# Typecheck & run tests (uses HITL_CHANNEL_TEST_ROOT isolation via preload)
bunx tsc --noEmit
bun test

# Start Claude Code channel mode standalone (development)
bun run src/server.ts

# Start ACP daemon mode (e.g., agy on 8790, codex on 8791, hermes on 8792)
bun run src/cli.ts daemon --harness agy --cwd ~/lab/hitl

# Configure Claude Code (add to .mcp.json)
{
  "mcpServers": {
    "hitl-channel": {
      "command": "bun",
      "args": ["run", "/path/to/hitl-channel/src/server.ts"],
      "env": { "HITL_CHANNEL_PORT": "8789" }
    }
  }
}
```

## Architecture

- **CLI Entrypoint** (`src/cli.ts`): Dispatches `daemon` (`src/daemon.ts`), `mcp-shim` (`src/mcp_shim.ts`), or channel mode (`src/server.ts`)
- **Channel MCP Server** (`src/server.ts`): Claude Code stdio MCP server delegating shared phone/reply tools to `src/mcp_tools.ts` and channel instructions to `src/mcp_instructions.ts`
- **Daemon & ACP Bridge** (`src/daemon.ts`, `src/acp_client.ts`, `src/acp_session_manager.ts`): Long-lived ACP client for `agy`, `codex`, and `hermes`; injects loopback HTTP MCP (`127.0.0.1` + bearer) or stdio `mcp-shim`; manages ACP sessions (`session/new`, `session/resume`, bounded `session/load` resume tails), `75 ms` coalesced `stream_delta`, `tool_progress`, `turn_state`, `cancel_turn`, `choices_settled`, and `HITL_DAEMON_SESSION=1` hook isolation
- **HTTP/WS Bridge** (`src/http_bridge.ts`): REST API + WebSocket for mobile app with `client_hello` capability negotiation (`sessions`, `choices_settled`, `streaming`), `/instance` capability metadata, and `choices_id`/`option_id` approval settlement
- **Pairing** (`src/pairing.ts`): 6-digit code generation with 5-min expiry
- **Allowlist & Paths** (`src/allowlist.ts`, `src/channel_home.ts`): SHA-256 device token allowlist and `HITL_CHANNEL_HOME` / `HITL_CHANNEL_TEST_ROOT` path resolution + test containment guard
- **Identity** (`src/identity.ts`): Persistent instance ID (`identity.json` for channel, `identity-daemon-<harness>.json` for daemons)
- **mDNS** (`src/mdns.ts`): Local network discovery (`_hitl-channel._tcp`, includes `mode`/`harness`/capabilities TXT)
- **Reply Buffer** (`src/reply_buffer.ts`): Per-instance in-memory ring buffer (cap 32/agent, 24h TTL) that queues durable frames when no WS client is connected and replays them on reconnect (ephemeral streaming frames never buffered). Peek + per-entry commit so partial-send failures don't lose data. SPEC-HITL-CC-001 AC#26.
- **Frame Correlator & Batch Questions** (`src/correlator.ts`, `src/questions_batch.ts`): `request_id` ↔ pending-Promise map and normalized multi-question batch handling
- **Audit Log** (`src/audit.ts`): Append-only JSONL at `~/.hitl/channels/audit/<YYYY-MM-DD>.jsonl`, closed-schema `AuditEvent` + `BufferDrainAuditLine`, 30-day local retention with oldest-first prune at startup.

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Unified CLI dispatcher (`daemon`, `mcp-shim`, default `server`) |
| `src/server.ts` | Claude Code stdio MCP channel server |
| `src/daemon.ts` | ACP daemon lifecycle, loopback HTTP MCP server, and desktop pairing notifications |
| `src/acp_client.ts` | JSON-RPC over stdio ACP subprocess client (`spawnAcpTransport`) |
| `src/acp_session_manager.ts` | Harness registry, ACP session management, `stream_delta`/`tool_progress`/`turn_state`/`cancel_turn`, and `choices_settled` |
| `src/mcp_tools.ts` | Shared MCP tools (`reply_to_hitl`, phone tool bridge, `push_file`) |
| `src/mcp_instructions.ts` | Channel & daemon MCP instructions (`createChannelInstructions`, `DAEMON_INSTRUCTIONS`) |
| `src/mcp_shim.ts` | Stdio ndjson ↔ loopback HTTP MCP proxy fallback |
| `src/http_bridge.ts` | HTTP/WS bridge, `client_hello` negotiation, `broadcastReply`, `unicastFrame`, `drainBufferToClient(Sync)` |
| `src/channel_home.ts` | `HITL_CHANNEL_HOME` and `HITL_CHANNEL_TEST_ROOT` containment helpers |
| `src/reply_buffer.ts` | Per-instance offline-reply ring buffer (AC#26) |
| `src/correlator.ts` | `request_id` ↔ pending-Promise map for tool-call round-trips |
| `src/questions_batch.ts` | Batch question normalization and validation |
| `src/audit.ts` | JSONL audit log with closed-schema event types |
| `src/pairing.ts` | Pairing code logic |
| `src/allowlist.ts` | Device token allowlist |
| `src/identity.ts` | Instance identity management |
| `src/mdns.ts` | mDNS service advertisement |
| `src/notification.ts` | Channel & desktop notification helpers |
| `src/types.ts` | TypeScript interfaces (incl. `HitlWebSocket`, `BufferedReply`, `client_hello`, Phase 3a/3b frame shapes) |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/instance` | GET | No | Instance identity + `mode`, `harness`, `capabilities` (`sessions`, `streaming`, `choicesId`) |
| `/pair/request` | POST | No | Request pairing code |
| `/pair/validate` | POST | No | Validate code, get token |
| `/` | POST | Yes | Send message or structured `choices_id`/`option_id` selection |
| `/ws` | GET | Yes | WebSocket with `client_hello` negotiation (`sessions`, `choices_settled`, `streaming`) and frames |

## Environment Variables

- `HITL_CHANNEL_PORT` (default: `8789` channel, `8790` `agy`, `8791` `codex`, `8792` `hermes`): Server port
- `HITL_CHANNEL_HOME` (default: `~/.hitl/channels`): Allowlist, identity, and audit directory
- `HITL_CHANNEL_IDENTITY_FILE`: Override identity file path
- `HITL_CHANNEL_NAME`: Display name (`<harness>@<hostname>` in daemon mode)
- `HITL_MCP_TRANSPORT` (default: `auto` in daemon mode): `auto`, `http`, or `stdio` (`mcp-shim`)
- `HITL_AGY_BIN` / `HITL_CODEX_ACP_BIN` / `HITL_HERMES_BIN`: Override harness binary path
- `INITIAL_AGENT_MODE`: Initial Codex mode (e.g., `workspace-write` or `read-only` to surface phone approval cards)
- `HITL_CHANNEL_API_KEY`: Legacy API key (optional)
- `HITL_CHANNEL_TEST_ROOT`: Temporary test state root enforced by `assertTestStatePath` during `bun test`

## Testing

```bash
bunx tsc --noEmit                     # Typecheck
bun test                              # All tests (preloaded with HITL_CHANNEL_TEST_ROOT isolation)
bun test src/__tests__/pairing.test.ts  # Specific test
```

## Known Issues

1. **mDNS in subprocess mode** (#3): `bonjour-service` mDNS fails when running as Claude Code MCP subprocess. Workaround: manual IP:port entry.

## Code Style

- TypeScript with strict mode
- Bun-native APIs (Bun.file, Bun.$, etc.)
- Process.stderr for logging (stdout reserved for MCP)
- Async/await over callbacks

## Related Repos

- [hitl-app](https://github.com/slaser79/hitl-app): Flutter mobile app
- [hitl-shin-relay](https://github.com/slaser79/hitl-shin-relay): Cloud relay service
- [hitl-cli](https://github.com/slaser79/hitl-cli): Python CLI/SDK
