# hitl-channel

**Claude Code MCP channel plugin for direct mobile-to-agent communication.**

hitl-channel is a TypeScript MCP server that enables bidirectional communication between the [HITL mobile app](https://hitlrelay.app) and Claude Code sessions — with no cloud intermediary. Messages travel directly over your LAN or Tailscale network.

## Features

- **Privacy-first**: Direct LAN/Tailscale connection, no relay server
- **Claude Code Channels**: Native MCP channel protocol (`notifications/claude/channel`)
- **Pairing flow**: Secure 6-digit code pairing with device token allowlist
- **mDNS discovery**: Auto-discovery on local network (`_hitl-channel._tcp`)
- **WebSocket bridge**: Real-time bidirectional messaging
- **Multi-instance**: Support multiple Claude Code sessions with distinct identities

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (recommended; required for `daemon` mode) or Node.js 20+ (Claude Code channel mode)
- **Channel mode:** Claude Code v2.1.80+ (channels require research preview)
- **Daemon mode:**
  - `--harness agy`: Antigravity CLI (`agy` supporting `agy acp`) on `PATH` (or `HITL_AGY_BIN`)
  - `--harness codex`: [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) (`codex-acp` on `PATH`, `HITL_CODEX_ACP_BIN`, or automatic `npx -y @agentclientprotocol/codex-acp` fallback)
  - `--harness hermes`: Hermes Agent CLI (`hermes acp` on `PATH`, or `HITL_HERMES_BIN`)
  - If you use `hitl-cli` Stop/notify hooks (`hitl-hook-review-and-continue`, `hitl-codex-notify`), update `hitl-cli` so hooks honor `HITL_DAEMON_SESSION=1`

### Install

```bash
# Clone
git clone https://github.com/slaser79/hitl-channel.git
cd hitl-channel
bun install
```

### Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hitl-channel": {
      "command": "bun",
      "args": ["run", "/path/to/hitl-channel/src/server.ts"],
      "env": {
        "HITL_CHANNEL_PORT": "8789"
      }
    }
  }
}
```

### Start Claude Code with Channels

```bash
claude --dangerously-load-development-channels server:hitl-channel
```

### Connect from HITL App

1. Open HITL app on your phone
2. Go to Agents > Claude Code > Add Instance
3. Enter your machine's IP and port 8789 (or discover via mDNS on same network)
4. Tap "Pair" — a 6-digit code will appear in your Claude Code session
5. Enter the code in the app
6. Start chatting!

## Architecture

```
hitl-app (phone)
    │
    ├── HTTP POST /           → Send messages to Claude Code
    ├── POST /pair/request    → Initiate pairing (code sent via channel notification)
    ├── POST /pair/validate   → Validate code, receive device token
    └── WebSocket /ws         → Receive replies from Claude Code
          │
          ▼
hitl-channel (MCP server, port 8789)
    │
    ├── channel notification  → Push messages into Claude Code session
    └── reply_to_hitl tool    → Claude Code sends replies back
          │
          ▼
Claude Code (your terminal)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HITL_CHANNEL_PORT` | `8789` (`8790` `agy`, `8791` `codex`, `8792` `hermes`) | HTTP/WebSocket bridge port |
| `HITL_CHANNEL_NAME` | `<harness>@<hostname>` (daemon mode) | Override instance display name |
| `HITL_CHANNEL_IDENTITY_FILE` | `~/.hitl/channels/identity.json` (daemon: `identity-daemon-<harness>.json`) | Override identity file path |
| `HITL_MCP_TRANSPORT` | `auto` (daemon mode) | MCP transport: `auto`, `http`, or `stdio` (`mcp-shim`) |
| `HITL_AGY_BIN` / `HITL_CODEX_ACP_BIN` / `HITL_HERMES_BIN` | binary on `PATH` | Override harness binary path in daemon mode |
| `HITL_CHANNEL_API_KEY` | (none) | Legacy API key auth (optional) |

## Data Storage

Identity and allowlist are stored in `~/.hitl/channels/`:

- `identity.json` — Instance ID (stable across restarts)
- `allowlist.json` — Paired device token hashes (SHA-256)

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check (status, port, client count) |
| `/instance` | GET | No | Instance identity (instanceId, hostname) |
| `/pair/request` | POST | No | Request pairing code (sent to Claude Code via channel) |
| `/pair/validate` | POST | No | Validate code, returns device token |
| `/` | POST | Yes | Send message to Claude Code |
| `/ws` | GET | Yes | WebSocket for receiving replies |

## Development

```bash
# Run tests
bun test

# Start standalone (for development)
bun src/server.ts
```

## Daemon mode

Run `hitl-channel` as a long-lived daemon (one daemon per harness: `agy`, `codex`, or `hermes`) to drive ACP harnesses directly from the HITL phone over LAN or Tailscale, without a cloud intermediary:

```bash
# Antigravity (default port 8790, display name agy@<hostname>)
bun run src/cli.ts daemon --harness agy --cwd ~/lab/hitl

# Codex via @agentclientprotocol/codex-acp (default port 8791)
bun run src/cli.ts daemon --harness codex --cwd ~/lab/hitl

# Hermes Agent (default port 8792)
bun run src/cli.ts daemon --harness hermes --cwd ~/lab/hitl
```

If an ACP harness does not support HTTP MCP (`mcpCapabilities.http === false`), daemon mode automatically falls back in `--mcp-transport auto` (or when forced via `--mcp-transport stdio`) to spawning `hitl-channel mcp-shim` as a stdio↔loopback-HTTP proxy.

### Pairing from the HITL App

1. Confirm your chosen harness binary is on `PATH` (`which agy`, `which codex-acp` / `npx -y @agentclientprotocol/codex-acp`, or `which hermes`).
2. Start the daemon for that harness (`bun run src/cli.ts daemon --harness <agy|codex|hermes> --cwd ~/lab/hitl`).
3. Open the HITL app on your phone, add/discover your host on that harness's port (`8790` `agy`, `8791` `codex`, `8792` `hermes`), and tap **Pair**.
4. Enter the 6-digit pairing code shown on daemon `stdout` (`PAIRING CODE: ...`) or in your desktop notification (`osascript` on macOS, `notify-send` on Linux).

### CLI Options

| Flag | Default | Description |
|---|---|---|
| `--harness <name>` | `agy` | ACP harness to spawn (`agy`, `codex`, or `hermes`) |
| `--port <port>` | `8790` (`agy`), `8791` (`codex`), `8792` (`hermes`) | HTTP/WS bridge listen port (or `HITL_CHANNEL_PORT`) |
| `--name <displayName>` | `<harness>@<hostname>` | Override instance display name |
| `--cwd <dir>` | current working directory | Default directory for auto-created / `/new` sessions |
| `--mcp-transport <mode>` | `auto` (or `HITL_MCP_TRANSPORT`) | MCP injection mode: `auto`, `http`, or `stdio` (`mcp-shim`) |

### Phone Chat Slash Commands

- `/help` — show supported daemon commands
- `/new [harness] [cwd]` — create and switch to a new session (default cwd if omitted; run a separate daemon per harness)
- `/sessions` — list the 10 most recent sessions with title, folder, and relative time
- `/resume <n|id>` — resume a session from `/sessions` (or by session ID)
- `/cancel` — cancel any pending approval cards and stop the active turn
- `/status` — show harness, active session, running state, queue depth, and pending approvals

### Daemon Identity & Hook Isolation

- **Separate identity:** Stored at `~/.hitl/channels/identity-daemon-<harness>.json` (override with `HITL_CHANNEL_IDENTITY_FILE`), so `agy`, `codex`, `hermes`, and Claude Code channel instances on the same host advertise distinct `instanceId`s.
- **Shared allowlist:** Paired device tokens are stored in `~/.hitl/channels/allowlist.json` (SHA-256 hashed).
- **Hook isolation (`HITL_DAEMON_SESSION=1`):** The daemon sets `HITL_DAEMON_SESSION=1` in spawned harness subprocess environments. Updated `hitl-cli` hooks (`hitl-hook-review-and-continue`, `review_and_continue_antigravity.py`, `review_and_continue_wrapper.sh`, and `hitl-codex-notify`) check `HITL_DAEMON_SESSION=1` and exit immediately without pinging the cloud relay or blocking turns. Set `HITL_HOOK_DEBUG=1` to log `daemon_session_skip` diagnostic markers.
- **Codex approval mode (`INITIAL_AGENT_MODE`):** `@agentclientprotocol/codex-acp` defaults to `agent` (Auto review), which executes workspace/sandboxed actions without raising `session/request_permission`. Export `INITIAL_AGENT_MODE=workspace-write` (prompt outside workspace or for network access) or `INITIAL_AGENT_MODE=read-only` (prompt before edits/commands) when starting `hitl-channel daemon --harness codex` to receive phone approval cards for those actions.

### Running at Login on macOS (`launchd`)

Save a plist such as `~/Library/LaunchAgents/com.hitl-channel.daemon.agy.plist` (replace `/path/to/bun` and `PATH` directories with the locations of `bun` and `agy` on your machine):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hitl-channel.daemon.agy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>run</string>
    <string>/path/to/hitl-channel/src/daemon.ts</string>
    <string>--harness</string>
    <string>agy</string>
    <string>--port</string>
    <string>8790</string>
    <string>--cwd</string>
    <string>/Users/you/workspace</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hitl-channel-daemon-agy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hitl-channel-daemon-agy.err.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.hitl-channel.daemon.agy.plist`.

### Wire Smoke (`agy` / `codex` / `hermes`)

```bash
python3 scripts/acp_smoke.py --harness agy
python3 scripts/acp_smoke.py --harness codex --handshake-only
python3 scripts/acp_smoke.py --harness hermes --handshake-only
```

## Related Projects

- [hitl-cli](https://github.com/slaser79/hitl-cli) — Python CLI/SDK for relay-based HITL (via hitlrelay.app)
- [hitl-app](https://hitlrelay.app) — HITL mobile app (iOS/Android)

## License

MIT
